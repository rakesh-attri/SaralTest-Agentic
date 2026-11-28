// `qa investigate --run <id>`: Failure Investigator over a finished run (Phase 7).
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Command } from 'commander';
import { projectPaths, requireConfig } from '../config/loader.js';
import { HardStopError } from '../core/errors.js';
import { newRunId, runPaths } from '../core/runFolder.js';
import type { InvestigationProviders } from '../agents/failure-investigator/experiments.js';
import { createProviders } from '../agents/failure-investigator/providers.js';
import { investigateRun } from '../agents/failure-investigator/run.js';
import { createSfContext } from '../sf/context.js';
import { createModelDeps } from './modelDeps.js';

type Say = (msg: string) => void;
const splitList = (s?: string): string[] | undefined =>
  s
    ?.split(',')
    .map((x) => x.trim())
    .filter(Boolean);

/** Org alias the source run used (run/execution-summary.json). */
export function orgOfRun(root: string, runId: string): string | undefined {
  const f = join(root, 'runs', runId, 'run', 'execution-summary.json');
  if (!existsSync(f)) return undefined;
  return (JSON.parse(readFileSync(f, 'utf8')) as { orgAlias?: string }).orgAlias;
}

export function registerInvestigate(program: Command, rootOf: () => string, say: Say): void {
  program
    .command('investigate')
    .description(
      'Investigate the failures of a finished run: signals → hypotheses → experiments → verdict (evidence-ledgered)',
    )
    .requiredOption('--run <id>', 'run whose FAIL / flaky results to investigate')
    .option('--org <alias>', 'org alias (default: the org of the run)')
    .option('--cases <ids>', 'only these cases (comma-separated)')
    .option('--run-id <id>', 'investigation run id (default inv-<timestamp>)')
    .option(
      '--offline',
      'no org access: only local experiments (requirement trace, data ledger, ARIA snapshot, snapshot diff)',
    )
    .option('--no-reruns', 'never rerun tests (observe-only experiments)')
    .option('--no-model', 'deterministic rules only (UNKNOWN when no rule decides)')
    .action(
      async (o: {
        run: string;
        org?: string;
        cases?: string;
        runId?: string;
        offline?: boolean;
        reruns: boolean;
        model: boolean;
      }) => {
        const root = rootOf();
        const runId = o.runId ?? newRunId('inv');
        const policy = await requireConfig('policy', projectPaths(root));
        const orgAlias = o.org ?? orgOfRun(root, o.run);
        const m = await createModelDeps({
          root,
          say,
          noModel: !o.model || Boolean(o.offline),
          logFile: runPaths(root, runId).runLog,
          roles: ['reasoning'],
        });
        let providers: InvestigationProviders = {};
        if (!o.offline && orgAlias) {
          try {
            const ctx = await createSfContext({ root, runId, orgAlias });
            const sf = await ctx.connect();
            say(`Identity verified: ${sf.identity.orgId} (${ctx.org.environment}).`);
            providers = createProviders({ root, runId, orgAlias, ctx, sf, reruns: o.reruns, say });
          } catch (e) {
            if (e instanceof HardStopError) throw e;
            say(`Org not reachable (${e instanceof Error ? e.message : String(e)}): only local experiments run.`);
            providers = {
              probe: () =>
                Promise.resolve({
                  identityOk: true,
                  healthy: false,
                  detail: e instanceof Error ? e.message : String(e),
                }),
            };
          }
        } else if (!orgAlias) {
          say('No org for this run: only local experiments run.');
        }
        const res = await investigateRun(
          { root, sourceRun: o.run, runId, ...(splitList(o.cases) ? { cases: splitList(o.cases) } : {}), policy, say },
          {
            ...(m.router ? { router: m.router } : {}),
            skills: m.skills,
            redactor: m.redactor,
            logger: m.logger,
            providers,
          },
        );
        const counts = new Map<string, number>();
        for (const x of res.investigations)
          counts.set(x.investigation.verdict, (counts.get(x.investigation.verdict) ?? 0) + 1);
        say(
          `Verdicts${res.environment === 'LIVE' ? '' : ` [${res.environment}]`}: ${[...counts].map(([v, n]) => `${v} ${n}`).join(' · ') || 'none'}`,
        );
        for (const f of res.files) say(`Saved: ${f}`);
      },
    );
}
