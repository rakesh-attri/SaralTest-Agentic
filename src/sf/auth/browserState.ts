import { mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Browser, BrowserContext, Page } from 'playwright';
import { z } from 'zod';
import { HardStopError, QAError } from '../../core/errors.js';
import type { BrowserName } from '../../config/schemas.js';
import type { SessionProvider, SessionRequest } from './types.js';

export interface StorageStateResult {
  path: string;
  reused: boolean;
  /** Host the browser landed on after frontdoor (identity evidence; no tokens). */
  landedHost: string;
  createdAt: string;
}

const Meta = z.object({
  orgId: z.string(),
  username: z.string(),
  personaId: z.string(),
  createdAt: z.string(),
  landedHost: z.string(),
  source: z.string(),
});
type Meta = z.infer<typeof Meta>;

export type BrowserLauncher = (opts: { browser: BrowserName; headless: boolean }) => Promise<Browser>;

/** Default launcher: Playwright with the configured channel (chromium | chrome | msedge). */
export const playwrightLauncher: BrowserLauncher = async ({ browser, headless }) => {
  const { chromium } = await import('playwright');
  return chromium.launch({ headless, ...(browser === 'chromium' ? {} : { channel: browser }) });
};

export interface EnsureStorageStateOptions {
  provider: SessionProvider;
  request: SessionRequest;
  /** Root folder for browser states (default `.auth`). States are stored per org: `.auth/<orgAlias>/<persona>.json`. */
  authDir: string;
  ttlMinutes: number;
  browser: BrowserName;
  headless?: boolean;
  launcher?: BrowserLauncher;
  timeoutMs?: number;
  now?: () => number;
}

export function storageStatePaths(
  authDir: string,
  orgAlias: string,
  personaId: string,
): { state: string; meta: string } {
  const dir = join(authDir, orgAlias);
  return { state: join(dir, `${personaId}.json`), meta: join(dir, `${personaId}.meta.json`) };
}

/** My Domain prefix of an instance URL (`https://acme.my.salesforce.com` → `acme`); hostname for anything else. */
export function myDomainOf(instanceUrl: string): string {
  const host = new URL(instanceUrl).hostname;
  const m = /^([^.]+)\.(?:my|sandbox\.my|develop\.my|scratch\.my)\.salesforce\.com$/.exec(host);
  return m?.[1] ?? host;
}

/** True when `landedHost` belongs to the org's My Domain (Lightning lives on `<mydomain>.lightning.force.com`). */
export function hostBelongsToOrg(landedHost: string, instanceUrl: string): boolean {
  const instanceHost = new URL(instanceUrl).hostname;
  if (landedHost === instanceHost) return true;
  const domain = myDomainOf(instanceUrl);
  if (domain === instanceHost) return false;
  return landedHost.startsWith(`${domain}.`) || landedHost.startsWith(`${domain}--`);
}

const LOGIN_URL =
  /\/(login|secur\/login_portal|_ui\/identity\/verification|identity\/verification)|[?&]startURL=.*verification/i;

/** Detect a login, MFA or verification page (the persona then becomes BLOCKED: AUTH, never typed into). */
export async function looksLikeLogin(page: Page): Promise<boolean> {
  if (LOGIN_URL.test(page.url())) return true;
  const password = await page.locator('input[type="password"]').count();
  const verify = await page.getByText(/verify your identity|verification code/i).count();
  return password > 0 || verify > 0;
}

function readMeta(file: string): Meta | undefined {
  try {
    return Meta.parse(JSON.parse(readFileSync(file, 'utf8')));
  } catch {
    return undefined;
  }
}

/**
 * Make sure `.auth/<org>/<persona>.json` holds a fresh browser session (salesforce-auth-personas skill):
 * one-time frontdoor URL → isolated context → wait for Lightning → `storageState`. Reused while younger than
 * `sessionTtlMinutes` and issued for the same org + user. Never types a password; a login/MFA page → AUTH issue.
 */
export async function ensureStorageState(o: EnsureStorageStateOptions): Promise<StorageStateResult> {
  const now = o.now ?? Date.now;
  const session = await o.provider.session(o.request);
  const paths = storageStatePaths(o.authDir, o.request.org.alias, o.request.persona.id);
  const meta = readMeta(paths.meta);
  if (!o.request.refresh && meta && meta.orgId === session.orgId && meta.username === session.username) {
    try {
      const age = now() - statSync(paths.state).mtimeMs;
      if (age < o.ttlMinutes * 60_000) {
        return { path: paths.state, reused: true, landedHost: meta.landedHost, createdAt: meta.createdAt };
      }
    } catch {
      // state file missing → create a new one
    }
  }

  const url = await o.provider.frontdoorUrl(o.request, '/lightning/page/home');
  const launcher = o.launcher ?? playwrightLauncher;
  const browser = await launcher({ browser: o.browser, headless: o.headless ?? true });
  let context: BrowserContext | undefined;
  try {
    context = await browser.newContext(); // isolated: never a personal profile
    const page = await context.newPage();
    const timeout = o.timeoutMs ?? 60_000;
    const response = await page.goto(url, { waitUntil: 'domcontentloaded', timeout });
    if (response && (response.status() === 401 || response.status() === 403)) {
      throw new QAError('AUTH', `frontdoor refused the session for persona ${o.request.persona.id}`, {
        persona: o.request.persona.id,
        status: response.status(),
      });
    }
    try {
      await page.waitForURL(/\/lightning\//, { timeout });
    } catch {
      if (await looksLikeLogin(page)) {
        throw new QAError('AUTH', `persona ${o.request.persona.id} landed on a login/MFA page after frontdoor`, {
          persona: o.request.persona.id,
          fix: 'Session expired or High Assurance required: re-run JWT login; never type passwords',
        });
      }
      throw new QAError('ENVIRONMENT', `Lightning did not load for persona ${o.request.persona.id}`, {
        persona: o.request.persona.id,
      });
    }
    if (await looksLikeLogin(page)) {
      throw new QAError('AUTH', `persona ${o.request.persona.id} sees a login/MFA prompt`, {
        persona: o.request.persona.id,
      });
    }
    const landedHost = new URL(page.url()).hostname;
    if (!hostBelongsToOrg(landedHost, o.request.org.instanceUrl)) {
      throw new HardStopError(
        'IDENTITY_MISMATCH',
        `browser landed on ${landedHost}, which is not the My Domain of ${o.request.org.alias}`,
      );
    }
    mkdirSync(join(o.authDir, o.request.org.alias), { recursive: true });
    await context.storageState({ path: paths.state });
    const createdAt = new Date(now()).toISOString();
    const newMeta: Meta = {
      orgId: session.orgId,
      username: session.username,
      personaId: o.request.persona.id,
      createdAt,
      landedHost,
      source: session.source,
    };
    writeFileSync(paths.meta, JSON.stringify(newMeta, null, 2), 'utf8');
    return { path: paths.state, reused: false, landedHost, createdAt };
  } finally {
    await context?.close().catch(() => undefined);
    await browser.close().catch(() => undefined);
  }
}
