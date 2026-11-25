// Locator dry-run (salesforce-lightning-locators skill, Enforcement): every page-object member a spec uses is
// resolved in its page state as the persona — count() === 1, visible, enabled — WITHOUT running any test.
// Uses the Playwright library and the Application Explorer's page specs (no MCP: CLAUDE.md rule 5; nothing saved,
// dialogs are cancelled). Record ids come from read-only SOQL on existing records.
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { Browser, Locator, Page } from 'playwright';
import { QAError } from '../../core/errors.js';
import { DryRunReport, type LocatorCheck } from '../../core/schemas/generation.js';
import { ensureStorageState, playwrightLauncher, type BrowserLauncher } from '../../sf/auth/browserState.js';
import type { GuardedSalesforce } from '../../sf/client.js';
import type { SfContext } from '../../sf/context.js';
import { PAGES, type PageEnv } from '../app-explorer/explorer.js';
import { applyLocator, parseLocatorExpression } from './expression.js';
import type { PageCatalog } from './pageObjects.js';

export interface DryRunPagesInput {
  browser: Browser;
  storageStatePath: string;
  env: PageEnv;
  catalog: PageCatalog;
  /** `<pageId>.<member>` refs to check; default: every member of the catalog. */
  refs?: string[];
  viewport?: { width: number; height: number };
  log?: (m: string) => void;
  now?: () => Date;
}

async function check(page: Page, expression: string): Promise<{ count: number; visible: boolean; enabled: boolean }> {
  const loc: Locator = applyLocator(page, parseLocatorExpression(expression));
  await loc
    .first()
    .waitFor({ state: 'visible', timeout: 4_000 })
    .catch(() => undefined);
  const count = await loc.count();
  if (count !== 1) return { count, visible: false, enabled: false };
  return { count, visible: await loc.isVisible(), enabled: await loc.isEnabled().catch(() => false) };
}

export async function dryRunPages(i: DryRunPagesInput): Promise<DryRunReport> {
  const log = i.log ?? (() => undefined);
  const wanted = i.refs ? new Set(i.refs) : undefined;
  const checks: LocatorCheck[] = [];
  const pageErrors: { page: string; error: string }[] = [];
  const context = await i.browser.newContext({
    storageState: i.storageStatePath,
    viewport: i.viewport ?? { width: 1440, height: 900 },
  });
  try {
    for (const p of i.catalog.pages) {
      const members = p.members.filter((m) => !wanted || wanted.has(`${p.id}.${m.name}`));
      if (!members.length) continue;
      const spec = PAGES[p.id];
      if (!spec) {
        pageErrors.push({ page: p.id, error: 'no page spec to open this page' });
        continue;
      }
      const page = await context.newPage();
      try {
        const opened = await spec.open(page, i.env, log);
        for (const m of members) {
          let r = await check(page, m.expression);
          let note: string | undefined;
          // Members on other tabs (Details / Related): bring the page into each captured state and retry.
          for (const cap of opened.captures) {
            if (r.count === 1 && r.visible) break;
            if (!cap.prepare) continue;
            await cap.prepare();
            r = await check(page, m.expression);
            if (r.count === 1) note = `state: ${cap.state}`;
          }
          const ok = r.count === 1 && r.visible && r.enabled;
          checks.push({
            element: `${p.id}.${m.name}`,
            page: p.id,
            persona: i.catalog.persona,
            expression: m.expression,
            ...r,
            ok,
            ...(note ? { note } : m.status === 'RE_VERIFY' ? { note: 'registry RE_VERIFY' } : {}),
          });
          log(`  ${ok ? 'ok  ' : 'FAIL'} ${p.id}.${m.name} (count ${r.count}${r.visible ? '' : ', not visible'})`);
        }
        await opened.cleanup?.();
      } catch (e) {
        pageErrors.push({ page: p.id, error: e instanceof Error ? (e.message.split('\n')[0] ?? 'error') : String(e) });
      } finally {
        await page.close().catch(() => undefined);
      }
    }
  } finally {
    await context.close().catch(() => undefined);
  }
  const expected = i.refs?.length ?? i.catalog.pages.reduce((n, p) => n + p.members.length, 0);
  return DryRunReport.parse({
    orgAlias: i.catalog.orgAlias,
    environment: i.catalog.environment,
    persona: i.catalog.persona,
    at: (i.now ?? (() => new Date()))().toISOString(),
    checks,
    pageErrors,
    ok: pageErrors.length === 0 && checks.length === expected && checks.every((c) => c.ok),
  });
}

export interface RunDryRunInput {
  ctx: Pick<SfContext, 'org' | 'persona' | 'provider' | 'authDir' | 'personas' | 'execution'>;
  sf: GuardedSalesforce;
  catalog: PageCatalog;
  refs?: string[];
  out?: string;
  launcher?: BrowserLauncher;
  log?: (m: string) => void;
}

/** Live/fixture dry-run: pick existing records read-only, get the persona's browser session, check members. */
export async function runDryRun(i: RunDryRunInput): Promise<DryRunReport> {
  const rows = await i.sf.query<{ Id: string; AccountId: string }>(
    'SELECT Id, AccountId FROM Contact WHERE AccountId != null ORDER BY CreatedDate DESC LIMIT 1',
  );
  const pick = rows[0];
  if (!pick) throw new QAError('DATA', 'no Contact with an Account exists to open the pages for the dry-run');
  const state = await ensureStorageState({
    provider: i.ctx.provider,
    request: { persona: i.ctx.persona, org: i.ctx.org },
    authDir: i.ctx.authDir,
    ttlMinutes: i.ctx.personas.sessionTtlMinutes,
    browser: i.ctx.execution.browser,
    headless: i.ctx.execution.headless,
  });
  const browser = await (i.launcher ?? playwrightLauncher)({
    browser: i.ctx.execution.browser,
    headless: i.ctx.execution.headless,
  });
  try {
    const baseUrl =
      new URL(i.ctx.org.instanceUrl).hostname === state.landedHost
        ? i.ctx.org.instanceUrl.replace(/\/+$/, '')
        : `https://${state.landedHost}`;
    const report = await dryRunPages({
      browser,
      storageStatePath: state.path,
      env: { baseUrl, accountId: pick.AccountId, contactId: pick.Id },
      catalog: i.catalog,
      ...(i.refs ? { refs: i.refs } : {}),
      ...(i.log ? { log: i.log } : {}),
    });
    if (i.out) {
      mkdirSync(dirname(i.out), { recursive: true });
      writeFileSync(i.out, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
    }
    return report;
  } finally {
    await browser.close().catch(() => undefined);
  }
}
