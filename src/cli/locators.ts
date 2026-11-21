import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { Command } from 'commander';
import { PAGES, runExplorer } from '../agents/app-explorer/index.js';
import { runDryRun } from '../agents/test-generator/dryRun.js';
import { buildCatalog, CATALOG_FILE, PageCatalog, writePageObjects } from '../agents/test-generator/pageObjects.js';
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
    .command('page-objects')
    .description('Generate tests/pages/*.ts + page-catalog.json from the registry (deterministic, no LLM)')
    .option('--org <alias>', 'org alias (default QA_DEFAULT_ORG)')
    .option('--persona <id>', 'persona (default from personas.yaml)')
    .action(async (o: { org?: string; persona?: string }) => {
      const root = rootOf();
      const ctx = await createSfContext({
        root,
        runId: newRunId('pages'),
        ...(o.org ? { orgAlias: o.org } : {}),
        ...(o.persona ? { personaId: o.persona } : {}),
      });
      const registry = new LocatorRegistry(registryFile(root));
      try {
        const cat = buildCatalog({
          entries: registry.list({ org: ctx.org.orgId }),
          org: ctx.org.orgId,
          orgAlias: ctx.org.alias,
          environment: ctx.org.environment,
          persona: ctx.persona.id,
        });
        const files = await writePageObjects(root, cat, (abs, text) => {
          mkdirSync(dirname(abs), { recursive: true });
          writeFileSync(abs, text, 'utf8');
        });
        for (const p of cat.pages) {
          const rv = p.members.filter((m) => m.status === 'RE_VERIFY').length;
          say(`  ${p.className}: ${p.members.length} members${rv ? ` (${rv} RE_VERIFY)` : ''}`);
        }
        say(`Wrote ${files.map((f) => f.path).join(', ')} (${ctx.org.environment}, persona ${ctx.persona.id}).`);
      } finally {
        registry.close();
      }
    });
  loc
    .command('dry-run')
    .description('Resolve page-object locators in their page states as the persona (no test is run; observe only)')
    .option('--org <alias>', 'org alias (default QA_DEFAULT_ORG)')
    .option('--persona <id>', 'persona (default from personas.yaml)')
    .option('--catalog <file>', 'page catalog', CATALOG_FILE)
    .option('--refs <list>', 'comma-separated <pageId>.<member> refs (default: every member)')
    .option('--manifest <file>', 'build manifest: check only the members the generated specs use')
    .option('--out <file>', 'write the report here (default runs/<runId>/dry-run.json)')
    .action(
      async (o: {
        org?: string;
        persona?: string;
        catalog: string;
        refs?: string;
        manifest?: string;
        out?: string;
      }) => {
        const root = rootOf();
        const ctx = await createSfContext({
          root,
          runId: newRunId('dryrun'),
          ...(o.org ? { orgAlias: o.org } : {}),
          ...(o.persona ? { personaId: o.persona } : {}),
        });
        const catalog = PageCatalog.parse(JSON.parse(readFileSync(join(root, o.catalog), 'utf8')));
        if (catalog.org !== ctx.org.orgId) {
          say(
            `Catalog was generated for ${catalog.orgAlias}, not ${ctx.org.alias}: regenerate with qa locators page-objects.`,
          );
          process.exitCode = 2;
          return;
        }
        let refs = o.refs?.split(',').map((x) => x.trim());
        if (o.manifest) {
          const m = JSON.parse(readFileSync(join(root, o.manifest), 'utf8')) as {
            artifacts?: { locatorsUsed?: string[] }[];
          };
          refs = [...new Set((m.artifacts ?? []).flatMap((a) => a.locatorsUsed ?? []))].sort();
        }
        const sf = await ctx.connect();
        say(
          `Identity verified: ${sf.identity.orgId} as ${sf.identity.username}. Dry-run (observe only, nothing saved).`,
        );
        const out = o.out ? join(root, o.out) : join(ctx.run.dir, 'dry-run.json');
        const r = await runDryRun({ ctx, sf, catalog, ...(refs ? { refs } : {}), out, log: say });
        const bad = r.checks.filter((c) => !c.ok);
        say(
          `Dry-run ${r.ok ? 'OK' : 'FAILED'}: ${r.checks.length - bad.length}/${r.checks.length} resolved (${r.environment}, persona ${r.persona}).`,
        );
        for (const e of r.pageErrors) say(`  page ${e.page}: ${e.error}`);
        say(`Report: ${out}`);
        process.exitCode = r.ok ? 0 : 1;
      },
    );
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
