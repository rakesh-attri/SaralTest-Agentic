// Runner preflight shared by `qa run` (src/runner/execute.ts) and `qa visual run` (src/visual/run.ts):
// identity check (HARD_STOP propagates) → browser resolution (fallback recorded) → persona browser sessions (base URL
// = landed host) → recipe approvals (missing → BLOCKED before any test is started).
import type { Browser } from '../core/schemas/execution.js';
import type { Autonomy } from '../core/state.js';
import { ensureStorageState } from '../sf/auth/browserState.js';
import type { GuardedSalesforce } from '../sf/client.js';
import { createSfContext, type SfContext } from '../sf/context.js';
import { planData, recipeApproval } from '../sf/dataFactory.js';
import { playwrightProbe, resolveBrowser, type BrowserChoice, type BrowserProbe } from './browser.js';

type Say = (msg: string) => void;

export interface PreflightDeps {
  probe?: BrowserProbe;
  createContext?: (o: { root: string; runId: string; orgAlias: string; personaId?: string }) => Promise<SfContext>;
  /** Browser session for a persona (default: ensureStorageState). */
  ensureSession?: (ctx: SfContext, browser: Browser) => Promise<{ landedHost: string; reused: boolean }>;
}

export interface PreflightOptions {
  root: string;
  runId: string;
  orgAlias: string;
  personas: readonly string[];
  recipes: readonly string[];
  browser?: string;
  autonomy?: Autonomy;
  say: Say;
}

export interface PreflightReady {
  ok: true;
  ctx: SfContext;
  sf: GuardedSalesforce;
  browser: BrowserChoice;
  baseURL: string;
  autonomy: Autonomy;
  /** Personas with a working session (Playwright projects to run). */
  projects: string[];
  sessionErrors: string[];
}

export interface PreflightBlocked {
  ok: false;
  why: string;
  browser?: BrowserChoice;
  ctx: SfContext;
}

export async function preflight(
  o: PreflightOptions,
  d: PreflightDeps = {},
): Promise<PreflightReady | PreflightBlocked> {
  const say = o.say;
  // identity (HARD_STOP propagates: the run ends BLOCKED)
  const mk = d.createContext ?? ((x) => createSfContext(x));
  const ctx = await mk({ root: o.root, runId: o.runId, orgAlias: o.orgAlias });
  const sf = await ctx.connect();
  say(`Identity verified: ${sf.identity.orgId} as ${sf.identity.username} (${ctx.org.environment}).`);

  // browser
  const browser = await resolveBrowser({
    ...(o.browser ? { option: o.browser } : {}),
    ...(process.env['QA_BROWSER'] ? { env: process.env['QA_BROWSER'] } : {}),
    configured: ctx.execution.browser,
    ...(ctx.execution.fallbackBrowser ? { fallback: ctx.execution.fallbackBrowser } : {}),
    probe: d.probe ?? playwrightProbe,
  });
  say(
    browser.fallbackReason
      ? `WARNING: browser fallback — ${browser.fallbackReason}. Every result records ${browser.browser}.`
      : `Browser: ${browser.browser} (from ${browser.source}).`,
  );

  // persona sessions → base URL (the host the frontdoor landed on)
  const ensure =
    d.ensureSession ??
    (async (c: SfContext, b: Browser) =>
      ensureStorageState({
        provider: c.provider,
        request: { persona: c.persona, org: c.org },
        authDir: c.authDir,
        ttlMinutes: c.personas.sessionTtlMinutes,
        browser: b,
        headless: c.execution.headless,
      }));
  let landedHost = '';
  const sessionErrors: string[] = [];
  for (const p of o.personas) {
    try {
      const pctx =
        p === ctx.persona.id ? ctx : await mk({ root: o.root, runId: o.runId, orgAlias: o.orgAlias, personaId: p });
      if (p !== ctx.persona.id) await pctx.connect();
      const st = await ensure(pctx, browser.browser);
      landedHost ||= st.landedHost;
      say(`  session ${p}: ${st.reused ? 'reused' : 'new'} (landed on ${st.landedHost})`);
    } catch (err) {
      sessionErrors.push(`${p}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  if (sessionErrors.length && sessionErrors.length === o.personas.length) {
    const why = `no persona session: ${sessionErrors.join('; ')}`;
    say(`BLOCKED: ${why}`);
    return { ok: false, why, browser, ctx };
  }
  for (const e of sessionErrors) say(`WARNING: persona session failed — ${e} (its tests will be BLOCKED)`);
  const instanceHost = new URL(ctx.org.instanceUrl).hostname;
  const baseURL =
    !landedHost || landedHost === instanceHost
      ? ctx.org.instanceUrl.replace(/\/+$/, '')
      : `${new URL(ctx.org.instanceUrl).protocol}//${landedHost}`;

  // recipe approvals (human checkpoint for new recipe versions; never asked from inside a test)
  const autonomy = o.autonomy ?? ctx.policy.autonomy;
  const missing: string[] = [];
  for (const r of o.recipes) {
    const { plan: dp } = planData({ ctx, recipe: r, runId: `${o.runId}-preflight` });
    if (!dp.valid) {
      missing.push(`${r}: data plan invalid (${dp.issues.map((i) => i.code).join(', ')})`);
      continue;
    }
    const st = recipeApproval(ctx, dp, autonomy);
    if (st.required && !st.approval) missing.push(`${r}: not approved for ${ctx.org.alias} — ${st.command}`);
    else say(`  recipe ${r}: ${st.approval ? `approved (${st.approval.id})` : `no approval needed at ${autonomy}`}`);
  }
  if (missing.length) {
    const why = `data approval needed before execution: ${missing.join('; ')}`;
    say(`BLOCKED: ${why}`);
    return { ok: false, why, browser, ctx };
  }
  const projects = o.personas.filter((p) => !sessionErrors.some((e) => e.startsWith(`${p}:`)));
  return { ok: true, ctx, sf, browser, baseURL, autonomy, projects, sessionErrors };
}
