import { existsSync } from 'node:fs';
import { z } from 'zod';
import { QAError } from '../../core/errors.js';
import type { SecretStore } from '../../security/secretStore.js';
import type { Runner } from '../../util/exec.js';
import type { SecretSink, SessionProvider, SessionRequest, SfSession } from './types.js';

const SfJson = z.looseObject({ status: z.number(), result: z.unknown().optional(), message: z.string().optional() });

const OrgDisplay = z.looseObject({
  id: z.string(),
  accessToken: z.string().min(10),
  instanceUrl: z.url(),
  username: z.string(),
  apiVersion: z.string().optional(),
  connectedStatus: z.string().optional(),
});

const OrgOpen = z.looseObject({ url: z.url(), orgId: z.string().optional(), username: z.string().optional() });

/** Parse `sf … --json` output. sf may print update notices before the JSON object. */
export function parseSfJson(stdout: string): z.infer<typeof SfJson> | undefined {
  const start = stdout.indexOf('{');
  if (start < 0) return undefined;
  try {
    const parsed = SfJson.safeParse(JSON.parse(stdout.slice(start)));
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}

/** Strip anything token-like from sf CLI messages before they become Issue text. */
function safeMessage(msg: string | undefined): string {
  return (msg ?? 'no message')
    .replace(/00D[A-Za-z0-9]{12,15}![A-Za-z0-9._-]+/g, '[REDACTED]')
    .replace(/(sid|otp|access_token)=[^&\s]+/gi, '$1=[REDACTED]')
    .slice(0, 300);
}

export interface SfCliProviderOptions {
  runner: Runner;
  secrets: SecretStore;
  /** Register tokens for masking (Redactor.addSecret). */
  onSecret?: SecretSink;
  /** Cached sessions are reused for this long (personas.yaml `sessionTtlMinutes`). */
  ttlMinutes: number;
  now?: () => number;
  timeoutMs?: number;
}

/**
 * Sessions from the sf CLI auth store (PLAN.md §7b). Each persona's alias is authorized once with
 * `sf org login jwt` against the External Client App; this provider reads the session with `sf org display` and, when
 * the stored auth is missing or expired and the ECA is configured, re-runs the JWT login non-interactively.
 */
export class SfCliSessionProvider implements SessionProvider {
  readonly kind = 'sf-cli+jwt' as const;
  private readonly cache = new Map<string, SfSession>();
  private readonly now: () => number;

  constructor(private readonly opts: SfCliProviderOptions) {
    this.now = opts.now ?? Date.now;
  }

  private async sf(args: string[]): Promise<{ ok: true; result: unknown } | { ok: false; message: string }> {
    const r = await this.opts.runner('sf', [...args, '--json'], { timeoutMs: this.opts.timeoutMs ?? 90_000 });
    if (r.error && r.code === null && !r.stdout) {
      if (/ENOENT|not found/i.test(r.error)) {
        throw new QAError('TOOL_UNAVAILABLE', 'Salesforce CLI (sf) is not installed or not on PATH', {
          fix: 'npm install -g @salesforce/cli',
        });
      }
      throw new QAError('TRANSIENT', `sf ${args[0] ?? ''} ${args[1] ?? ''} failed: ${safeMessage(r.error)}`);
    }
    const json = parseSfJson(r.stdout);
    if (!json) return { ok: false, message: safeMessage(r.stderr || 'sf returned no JSON') };
    if (json.status !== 0) return { ok: false, message: safeMessage(json.message) };
    return { ok: true, result: json.result };
  }

  private key(req: SessionRequest): string {
    return `${req.org.alias}::${req.persona.id}`;
  }

  async session(req: SessionRequest): Promise<SfSession> {
    const k = this.key(req);
    const cached = this.cache.get(k);
    if (!req.refresh && cached && this.now() - cached.obtainedAt < this.opts.ttlMinutes * 60_000) return cached;

    let display = await this.display(req.persona.sfAlias);
    let source: SfSession['source'] = 'sf-cli';
    if (!display.ok) {
      const jwt = await this.jwtConfig();
      if (!jwt) {
        throw new QAError(
          'AUTH',
          `sf alias "${req.persona.sfAlias}" (persona ${req.persona.id}) has no usable session: ${display.message}`,
          { persona: req.persona.id, fix: 'Set SF_ECA_CLIENT_ID and SF_JWT_KEY_PATH, then run qa auth login' },
        );
      }
      await this.jwtLogin(req, jwt);
      display = await this.display(req.persona.sfAlias);
      source = 'jwt';
      if (!display.ok) {
        throw new QAError('AUTH', `session still unusable after JWT login: ${display.message}`, {
          persona: req.persona.id,
        });
      }
    }
    const d = display.value;
    this.opts.onSecret?.(d.accessToken);
    const session: SfSession = {
      orgAlias: req.org.alias,
      personaId: req.persona.id,
      username: d.username,
      orgId: d.id,
      instanceUrl: d.instanceUrl.replace(/\/+$/, ''),
      accessToken: d.accessToken,
      apiVersion: d.apiVersion ?? '62.0',
      source,
      obtainedAt: this.now(),
    };
    this.cache.set(k, session);
    return session;
  }

  private async display(
    alias: string,
  ): Promise<{ ok: true; value: z.infer<typeof OrgDisplay> } | { ok: false; message: string }> {
    const r = await this.sf(['org', 'display', '--target-org', alias]);
    if (!r.ok) return r;
    const parsed = OrgDisplay.safeParse(r.result);
    if (!parsed.success) return { ok: false, message: 'sf org display returned no access token' };
    const status = parsed.data.connectedStatus;
    if (status && status !== 'Connected' && !/^Unknown/i.test(status)) {
      return { ok: false, message: safeMessage(status) };
    }
    return { ok: true, value: parsed.data };
  }

  /** ECA client id + key file, from Credential Manager first, then env. Values are never echoed. */
  async jwtConfig(): Promise<{ clientId: string; keyFile: string } | undefined> {
    const clientId = (await this.opts.secrets.get('SF_ECA_CLIENT_ID')).value;
    const keyFile = (await this.opts.secrets.get('SF_JWT_KEY_PATH')).value;
    if (!clientId || !keyFile) return undefined;
    if (!existsSync(keyFile)) {
      throw new QAError('AUTH', 'SF_JWT_KEY_PATH points to a file that does not exist', {
        fix: 'Check the path in .env (comments must be on their own line) or Credential Manager',
      });
    }
    return { clientId, keyFile };
  }

  /**
   * Non-interactive JWT Bearer login (no password, no MFA prompt). Refreshes the alias in the sf auth store.
   */
  async jwtLogin(req: SessionRequest, jwt?: { clientId: string; keyFile: string }): Promise<void> {
    const cfg = jwt ?? (await this.jwtConfig());
    if (!cfg) {
      throw new QAError('AUTH', 'JWT login needs SF_ECA_CLIENT_ID and SF_JWT_KEY_PATH', { persona: req.persona.id });
    }
    const r = await this.sf([
      'org',
      'login',
      'jwt',
      '--client-id',
      cfg.clientId,
      '--jwt-key-file',
      cfg.keyFile,
      '--username',
      req.persona.username,
      '--alias',
      req.persona.sfAlias,
      '--instance-url',
      req.org.instanceUrl,
    ]);
    if (!r.ok) {
      throw new QAError('AUTH', `JWT login failed for persona ${req.persona.id}: ${r.message}`, {
        persona: req.persona.id,
        fix: 'Check the user is pre-approved on the External Client App and the certificate matches the key',
      });
    }
    this.cache.delete(this.key(req));
  }

  async frontdoorUrl(req: SessionRequest, path = '/lightning/page/home'): Promise<string> {
    await this.session(req); // makes sure the alias is usable (JWT re-login if needed)
    const r = await this.sf(['org', 'open', '--url-only', '--target-org', req.persona.sfAlias, '--path', path]);
    if (!r.ok) throw new QAError('AUTH', `could not get a frontdoor URL: ${r.message}`, { persona: req.persona.id });
    const parsed = OrgOpen.safeParse(r.result);
    if (!parsed.success) throw new QAError('AUTH', 'sf org open returned no URL', { persona: req.persona.id });
    this.opts.onSecret?.(parsed.data.url);
    return parsed.data.url;
  }
}
