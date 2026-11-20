import { createSign } from 'node:crypto';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { z } from 'zod';
import { QAError } from '../../core/errors.js';
import type { SecretStore } from '../../security/secretStore.js';
import type { Runner } from '../../util/exec.js';
import type { SecretSink, SessionProvider, SessionRequest, SfSession } from './types.js';

const SfJson = z.looseObject({ status: z.number(), result: z.unknown().optional(), message: z.string().optional() });
const OrgOpen = z.looseObject({ url: z.url(), orgId: z.string().optional(), username: z.string().optional() });
const TokenResponse = z.looseObject({ access_token: z.string().min(10), instance_url: z.url(), id: z.string() });
const TokenError = z.looseObject({ error: z.string(), error_description: z.string().optional() });
const Versions = z.array(z.looseObject({ version: z.string() }));

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

/** Strip anything token-like from CLI / OAuth messages before they become Issue text. */
function safeMessage(msg: string | undefined): string {
  return (msg ?? 'no message')
    .replace(/00D[A-Za-z0-9]{12,15}![A-Za-z0-9._-]+/g, '[REDACTED]')
    .replace(/(sid|otp|access_token|assertion)=[^&\s]+/gi, '$1=[REDACTED]')
    .slice(0, 300);
}

const b64url = (s: string | Buffer): string => Buffer.from(s).toString('base64url');

/** OAuth audience for the JWT Bearer flow: sandboxes use test.salesforce.com, everything else login.salesforce.com. */
export function jwtAudience(instanceUrl: string): string {
  const host = new URL(instanceUrl).hostname;
  return /\.sandbox\.my\.salesforce\.com$|^test\.salesforce\.com$|--/.test(host)
    ? 'https://test.salesforce.com'
    : 'https://login.salesforce.com';
}

/** RS256-signed JWT assertion (header.claims.signature), valid for 3 minutes. */
export function signJwtAssertion(o: {
  clientId: string;
  username: string;
  audience: string;
  privateKey: string;
  nowSeconds: number;
}): string {
  const header = b64url(JSON.stringify({ alg: 'RS256' }));
  const claims = b64url(JSON.stringify({ iss: o.clientId, sub: o.username, aud: o.audience, exp: o.nowSeconds + 180 }));
  const signer = createSign('RSA-SHA256');
  signer.update(`${header}.${claims}`);
  return `${header}.${claims}.${signer.sign(o.privateKey).toString('base64url')}`;
}

/** `https://login.salesforce.com/id/00D…/005…` → { orgId, userId }. */
export function parseIdentityUrl(id: string): { orgId: string; userId: string } | undefined {
  const m = /\/id\/(00D[A-Za-z0-9]{12,15})\/(005[A-Za-z0-9]{12,15})/.exec(id);
  return m?.[1] && m[2] ? { orgId: m[1], userId: m[2] } : undefined;
}

export interface SfCliProviderOptions {
  runner: Runner;
  secrets: SecretStore;
  /** Register tokens and keys for masking (Redactor.addSecret). */
  onSecret?: SecretSink;
  /** Cached sessions are reused for this long (personas.yaml `sessionTtlMinutes`). */
  ttlMinutes: number;
  fetch?: typeof fetch;
  now?: () => number;
  timeoutMs?: number;
}

/**
 * Live Salesforce sessions via the External Client App (PLAN.md §7b).
 *
 * - **API sessions**: OAuth 2.0 JWT Bearer grant signed in-process with the ECA private key (no password, no MFA).
 *   The sf CLI redacts access tokens in its JSON output, so the token is obtained directly and lives in memory only.
 * - **sf CLI alias** (`sf org login jwt`): kept authorized for the browser frontdoor (`sf org open --url-only`) and the
 *   Salesforce DX MCP server.
 */
export class SfCliSessionProvider implements SessionProvider {
  readonly kind = 'sf-cli+jwt' as const;
  private readonly cache = new Map<string, SfSession>();
  private readonly now: () => number;
  private readonly fetch: typeof fetch;

  constructor(private readonly opts: SfCliProviderOptions) {
    this.now = opts.now ?? Date.now;
    this.fetch = opts.fetch ?? globalThis.fetch.bind(globalThis);
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

  private async requireJwt(req: SessionRequest): Promise<{ clientId: string; keyFile: string }> {
    const cfg = await this.jwtConfig();
    if (!cfg) {
      throw new QAError('AUTH', `persona ${req.persona.id}: API sessions need SF_ECA_CLIENT_ID and SF_JWT_KEY_PATH`, {
        persona: req.persona.id,
        fix: 'Create the External Client App + certificate (docs/setup/salesforce-auth.md) and set both values',
      });
    }
    return cfg;
  }

  async session(req: SessionRequest): Promise<SfSession> {
    const k = this.key(req);
    const cached = this.cache.get(k);
    if (!req.refresh && cached && this.now() - cached.obtainedAt < this.opts.ttlMinutes * 60_000) return cached;

    const cfg = await this.requireJwt(req);
    const privateKey = await readFile(cfg.keyFile, 'utf8');
    this.opts.onSecret?.(privateKey.trim());
    const tokenBase = req.org.instanceUrl.replace(/\/+$/, '');
    const assertion = signJwtAssertion({
      clientId: cfg.clientId,
      username: req.persona.username,
      audience: jwtAudience(tokenBase),
      privateKey,
      nowSeconds: Math.floor(this.now() / 1000),
    });
    let res: Response;
    try {
      res = await this.fetch(`${tokenBase}/services/oauth2/token`, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion }).toString(),
      });
    } catch (err) {
      throw new QAError(
        'TRANSIENT',
        `JWT token request failed: ${safeMessage(err instanceof Error ? err.message : String(err))}`,
      );
    }
    const body: unknown = await res.json().catch(() => ({}));
    if (!res.ok) {
      const e = TokenError.safeParse(body);
      const what = e.success ? `${e.data.error}: ${e.data.error_description ?? ''}` : `HTTP ${String(res.status)}`;
      throw new QAError(
        res.status >= 500 ? 'TRANSIENT' : 'AUTH',
        `JWT login failed for persona ${req.persona.id} — ${safeMessage(what)}`,
        {
          persona: req.persona.id,
          status: res.status,
          fix: 'Check the user is pre-approved on the External Client App and the certificate matches the key',
        },
      );
    }
    const tok = TokenResponse.parse(body);
    this.opts.onSecret?.(tok.access_token);
    const ids = parseIdentityUrl(tok.id);
    if (!ids) throw new QAError('AUTH', 'token response has no identity URL (org/user unknown)');
    const instanceUrl = tok.instance_url.replace(/\/+$/, '');
    const apiVersion = await this.latestApiVersion(instanceUrl);
    const session: SfSession = {
      orgAlias: req.org.alias,
      personaId: req.persona.id,
      username: req.persona.username,
      orgId: ids.orgId,
      instanceUrl,
      accessToken: tok.access_token,
      apiVersion,
      source: 'jwt',
      obtainedAt: this.now(),
    };
    this.cache.set(k, session);
    return session;
  }

  private async latestApiVersion(instanceUrl: string): Promise<string> {
    try {
      const res = await this.fetch(`${instanceUrl}/services/data`);
      const versions = Versions.parse(await res.json());
      return versions.at(-1)?.version ?? '62.0';
    } catch {
      return '62.0';
    }
  }

  /** `sf org login jwt` for the persona's alias (browser frontdoor + MCP use the sf CLI auth store). */
  async jwtLogin(req: SessionRequest): Promise<void> {
    const cfg = await this.requireJwt(req);
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
      throw new QAError('AUTH', `sf org login jwt failed for persona ${req.persona.id}: ${r.message}`, {
        persona: req.persona.id,
        fix: 'Check the user is pre-approved on the External Client App and the certificate matches the key',
      });
    }
  }

  async frontdoorUrl(req: SessionRequest, path = '/lightning/page/home'): Promise<string> {
    const open = (): Promise<{ ok: true; result: unknown } | { ok: false; message: string }> =>
      this.sf(['org', 'open', '--url-only', '--target-org', req.persona.sfAlias, '--path', path]);
    let r = await open();
    if (!r.ok && (await this.jwtConfig())) {
      await this.jwtLogin(req); // alias missing/expired → re-authorize non-interactively, then retry once
      r = await open();
    }
    if (!r.ok) throw new QAError('AUTH', `could not get a frontdoor URL: ${r.message}`, { persona: req.persona.id });
    const parsed = OrgOpen.safeParse(r.result);
    if (!parsed.success) throw new QAError('AUTH', 'sf org open returned no URL', { persona: req.persona.id });
    this.opts.onSecret?.(parsed.data.url);
    return parsed.data.url;
  }
}
