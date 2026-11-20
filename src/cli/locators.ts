import { join } from 'node:path';
import type { Command } from 'commander';
import { PAGES, runExplorer } from '../agents/app-explorer/index.js';
import { newRunId } from '../core/runFolder.js';
import { LocatorRegistry } from '../knowledge/locatorRegistry.js';
import { SnapshotStore } from '../knowledge/snapshotStore.js';
import type { GuardedSalesforce } from '../sf/client.js';
import { createSfContext, type SfContext } from '../sf/context.js';
import { GraphStore } from '../sf/graph/graphStore.js';

type Say = (msg: string) => void;

export const DEFAULT_PAGES = ['account-record', 'contact-record', 'contact-new'];

export const registryFile = (root: string): string => join(root, '.qa-memory', 'locators.db');

/** Explore pages and print a per-page summary (shared by `qa locators discover` and `qa discover --ui`). */
export async function exploreAndRegister(
  ctx: SfContext,
  sf: GuardedSalesforce,
  pageIds: string[],
  say: Say,
): Promise<number> {
  const registry = new LocatorRegistry(registryFile(ctx.root));
  const snapshots = new SnapshotStore(join(ctx.root, '.qa-memory', 'knowledge.db'));
  const graph = new GraphStore(join(ctx.root, '.qa-memory', 'graph.db'));
  try {
    say(
      `Application Explorer — ${pageIds.join(', ')} as persona ${ctx.persona.id} (${ctx.org.environment}; observe only, dialogs cancelled).`,
    );
    const r = await runExplorer({ ctx, sf, pageIds, registry, snapshots, graph, log: say });
    for (const p of r.pages) {
      say(`  ${p.page}: ${p.error ? `FAILED (${p.error})` : `${p.locators} locators`} via ${p.path || '?'}`);
    }
    const pages = registry.pages(ctx.org.orgId);
    say(`Registry: ${pages.map((p) => `${p.page}=${p.count}`).join(', ')} (${registryFile(ctx.root)})`);
    return r.pages.filter((p) => !p.error).length;
  } finally {
    registry.close();
    snapshots.close();
    graph.close();
  }
}

export function registerLocators(program: Command, rootOf: () => string, say: Say): void {
  const loc = program.command('locators').description('Locator registry: Application Explorer (Lightning) and listing');
  loc
    .command('discover')
    .description(`Explore pages and register role-based locators (pages: ${Object.keys(PAGES).join(', ')})`)
    .option('--org <alias>', 'org alias (default QA_DEFAULT_ORG)')
    .option('--persona <id>', 'persona (default from personas.yaml)')
    .option('--pages <list>', 'comma-separated page ids', DEFAULT_PAGES.join(','))
    .action(async (o: { org?: string; persona?: string; pages: string }) => {
      const root = rootOf();
      const ctx = await createSfContext({
        root,
        runId: newRunId('explore'),
        ...(o.org ? { orgAlias: o.org } : {}),
        ...(o.persona ? { personaId: o.persona } : {}),
      });
      const sf = await ctx.connect();
      say(`Identity verified: ${sf.identity.orgId} as ${sf.identity.username}.`);
      const ok = await exploreAndRegister(
        ctx,
        sf,
        o.pages.split(',').map((x) => x.trim()),
        say,
      );
      say(`Evidence: ${join(ctx.run.dir, 'explorer')}`);
      process.exitCode = ok ? 0 : 1;
    });
  loc
    .command('list')
    .description('List registered locators')
    .option('--org <alias>', 'org alias (default QA_DEFAULT_ORG)')
    .option('--page <id>', 'only this page')
    .option('--json', 'JSON output')
    .action(async (o: { org?: string; page?: string; json?: boolean }) => {
      const root = rootOf();
      const ctx = await createSfContext({ root, runId: newRunId('locators'), ...(o.org ? { orgAlias: o.org } : {}) });
      const registry = new LocatorRegistry(registryFile(root));
      try {
        const list = registry.list({ org: ctx.org.orgId, ...(o.page ? { page: o.page } : {}) });
        if (o.json) {
          process.stdout.write(`${JSON.stringify(list, null, 2)}\n`);
          return;
        }
        for (const p of registry.pages(ctx.org.orgId)) process.stdout.write(`${p.page}: ${p.count}\n`);
        for (const l of list) {
          process.stdout.write(
            `  [${l.page}] r${l.strategyRank} ${l.status.padEnd(9)} ${l.expression}${l.fieldApiName ? `  → ${l.fieldApiName}` : ''}\n`,
          );
        }
      } finally {
        registry.close();
      }
    });
}
