import { join } from 'node:path';
import { QAError } from '../../core/errors.js';
import type { LocatorRegistry } from '../../knowledge/locatorRegistry.js';
import type { SnapshotStore } from '../../knowledge/snapshotStore.js';
import { ensureStorageState, playwrightLauncher, type BrowserLauncher } from '../../sf/auth/browserState.js';
import type { GuardedSalesforce } from '../../sf/client.js';
import type { SfContext } from '../../sf/context.js';
import type { GraphStore } from '../../sf/graph/graphStore.js';
import { linkAssets } from '../../sf/graph/assetLinks.js';
import { assetsFromRegistry, explorePages, PAGES, type PageResult } from './explorer.js';

export { PAGES, explorePages, assetsFromRegistry, type PageSpec, type PageResult } from './explorer.js';
export { parseAriaSnapshot } from './aria.js';

export interface RunExplorerInput {
  ctx: Pick<
    SfContext,
    'org' | 'persona' | 'provider' | 'authDir' | 'personas' | 'execution' | 'redactor' | 'run' | 'root'
  >;
  sf: GuardedSalesforce;
  pageIds: string[];
  registry: LocatorRegistry;
  snapshots?: SnapshotStore;
  graph?: GraphStore;
  launcher?: BrowserLauncher;
  log?: (m: string) => void;
}

/**
 * Explore pages as the run's persona and register locators (read-only). Record ids come from read-only SOQL on
 * existing records; the browser session comes from the frontdoor storageState.
 */
export async function runExplorer(i: RunExplorerInput): Promise<{ pages: PageResult[]; registered: number }> {
  const log = i.log ?? (() => undefined);
  const unknown = i.pageIds.filter((p) => !PAGES[p]);
  if (unknown.length)
    throw new QAError('UNKNOWN', `unknown page id(s): ${unknown.join(', ')} (known: ${Object.keys(PAGES).join(', ')})`);
  const rows = await i.sf.query<{ Id: string; AccountId: string }>(
    'SELECT Id, AccountId FROM Contact WHERE AccountId != null ORDER BY CreatedDate DESC LIMIT 1',
  );
  const pick = rows[0];
  if (!pick)
    throw new QAError('DATA', 'no Contact with an Account exists to explore (Phase 2 explores existing records only)');

  // Values shown on these pages: never become locators (kept in memory only).
  const recordValues: string[] = [];
  const collect = async (soql: string): Promise<void> => {
    try {
      for (const r of await i.sf.query(soql)) {
        for (const v of Object.values(r))
          if (typeof v === 'string' && !/^[a-zA-Z0-9]{15,18}$/.test(v)) recordValues.push(v);
      }
    } catch {
      // optional: some fields may not exist (fixture)
    }
  };
  await collect(`SELECT Name FROM Account WHERE Id = '${pick.AccountId}'`);
  await collect(`SELECT FirstName, LastName, Email, Phone FROM Contact WHERE AccountId = '${pick.AccountId}'`);
  await collect(`SELECT FirstName, LastName, Email, Phone FROM Contact WHERE Id = '${pick.Id}'`);

  const state = await ensureStorageState({
    provider: i.ctx.provider,
    request: { persona: i.ctx.persona, org: i.ctx.org },
    authDir: i.ctx.authDir,
    ttlMinutes: i.ctx.personas.sessionTtlMinutes,
    browser: i.ctx.execution.browser,
    headless: i.ctx.execution.headless,
    ...(i.launcher ? { launcher: i.launcher } : {}),
  });
  const latest = i.snapshots?.latest(i.ctx.org.orgId);
  const snapshot = latest ? i.snapshots?.get(latest.id) : undefined;
  const fields = snapshot?.components.filter((c) => c.type === 'Field') ?? [];
  const browser = await (i.launcher ?? playwrightLauncher)({
    browser: i.ctx.execution.browser,
    headless: i.ctx.execution.headless,
  });
  try {
    const baseUrl =
      new URL(i.ctx.org.instanceUrl).hostname === state.landedHost
        ? i.ctx.org.instanceUrl.replace(/\/+$/, '')
        : `https://${state.landedHost}`;
    const out = await explorePages({
      browser,
      storageStatePath: state.path,
      env: { baseUrl, accountId: pick.AccountId, contactId: pick.Id },
      pages: i.pageIds.map((p) => PAGES[p]).filter((p) => p !== undefined),
      org: i.ctx.org.orgId,
      persona: i.ctx.persona.id,
      environment: i.ctx.org.environment,
      fields,
      ...(snapshot ? { snapshotId: snapshot.info.id } : {}),
      recordValues,
      evidenceDir: join(i.ctx.run.dir, 'explorer'),
      redactor: i.ctx.redactor,
      log,
    });
    const registered = i.registry.upsert(out.entries);
    if (i.snapshots && snapshot) {
      for (const p of out.pages.filter((x) => !x.error)) {
        i.snapshots.recordLineage({
          assetType: 'locator-page',
          assetId: p.page,
          snapshotId: snapshot.info.id,
          observationIds: [p.observationId],
        });
      }
    }
    if (i.graph && snapshot) {
      const linked = linkAssets(assetsFromRegistry(i.registry, i.ctx.org.orgId), snapshot.components);
      i.graph.addEdges(i.ctx.org.orgId, linked.nodes, linked.edges);
    }
    return { pages: out.pages, registered };
  } finally {
    await browser.close().catch(() => undefined);
  }
}
