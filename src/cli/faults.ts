// `qa faults run --suite <file>` (Phase 7): fault-injection suite on the offline fixture.
import { join, resolve } from 'node:path';
import type { Command } from 'commander';
import { projectPaths, requireConfig } from '../config/loader.js';
import { newRunId, runPaths } from '../core/runFolder.js';
import type { Autonomy } from '../core/state.js';
import { createProviders } from '../agents/failure-investigator/providers.js';
import { investigateRun, ledgerFile } from '../agents/failure-investigator/run.js';
import { readCatalog } from '../agents/self-healer/index.js';
import { healRun } from '../agents/self-healer/run.js';
import { loadFaultSuite, runFaultSuite } from '../faults/suite.js';
import { startFixtureServer } from '../fixture/server.js';
import { EvidenceLedger } from '../knowledge/evidenceLedger.js';
import { executeStory } from '../runner/execute.js';
import { ApprovalStore } from '../security/approvals.js';
import { createSfContext } from '../sf/context.js';
import { registryFile } from './locators.js';
import { createModelDeps } from './modelDeps.js';

type Say = (msg: string) => void;

export function registerFaults(program: Command, rootOf: () => string, say: Say): void {
  const faults = program.command('faults').description('Fault injection (offline fixture): classify, heal, score');
  faults
    .command('run')
    .description(
      'Run a fault suite: per fault start the fixture with it, run the case, investigate, heal script faults, score',
    )
    .requiredOption('--suite <file>', 'suite file (e.g. examples/faults/fixture-suite.yaml)')
    .option('--only <ids>', 'only these fault ids (comma-separated)')
    .option('--run-id <id>', 'suite run id (default flt-<timestamp>)')
    .option('--no-model', 'deterministic rules only')
    .action(async (o: { suite: string; only?: string; runId?: string; model: boolean }) => {
      const root = rootOf();
      const runId = o.runId ?? newRunId('flt');
      const suite = loadFaultSuite(resolve(root, o.suite));
      const policy = await requireConfig('policy', projectPaths(root));
      const orgs = await requireConfig('orgs', projectPaths(root));
      const org = orgs.orgs.find((x) => x.alias === suite.org);
      if (!org || org.environment !== 'FIXTURE') {
        say(
          `Fault suites run only against the offline fixture (org "${suite.org}" is ${org?.environment ?? 'unknown'}).`,
        );
        process.exitCode = 2;
        return;
      }
      const port = Number(new URL(org.instanceUrl).port || 4545);
      const autonomy: Autonomy = 'L3'; // fixture: as every fixture run (no recipe checkpoint at L3)
      const m = await createModelDeps({
        root,
        say,
        noModel: !o.model,
        logFile: runPaths(root, runId).runLog,
        roles: ['reasoning'],
      });
      const quiet = (): void => undefined;
      const { scorecard, files } = await runFaultSuite(
        { root, suite, runId, ...(o.only ? { only: o.only.split(',').map((x) => x.trim()) } : {}) },
        {
          say,
          startFixture: async (f) =>
            startFixtureServer({ fixtureDir: join(root, 'examples', 'fixture'), port, faults: f }),
          runCase: async ({ runId: rid, caseId, storyKey, org: alias }) => {
            const out = await executeStory({
              root,
              runId: rid,
              storyKey,
              orgAlias: alias,
              cases: [caseId],
              autonomy,
              echo: false,
              say: quiet,
            });
            return out.results.find((r) => r.caseId === caseId);
          },
          investigate: async ({ sourceRun, runId: rid }) => {
            const ctx = await createSfContext({ root, runId: rid, orgAlias: suite.org });
            const sf = await ctx.connect();
            const providers = createProviders({
              root,
              runId: rid,
              orgAlias: suite.org,
              ctx,
              sf,
              reruns: true,
              say: quiet,
              autonomy,
            });
            const res = await investigateRun(
              { root, sourceRun, runId: rid, policy, say: quiet },
              {
                ...(m.router ? { router: m.router } : {}),
                skills: m.skills,
                redactor: m.redactor,
                logger: m.logger,
                providers,
              },
            );
            return res.investigations.map((x) => x.investigation);
          },
          heal: async ({ investigationRun, runId: rid }) => {
            const ctx = await createSfContext({ root, runId: rid, orgAlias: suite.org });
            const sf = await ctx.connect();
            const rerun = createProviders({
              root,
              runId: rid,
              orgAlias: suite.org,
              ctx,
              sf,
              reruns: true,
              say: quiet,
              autonomy,
            }).rerun;
            const ledger = new EvidenceLedger(ledgerFile(root));
            try {
              const res = await healRun(
                { investigationRun, apply: true },
                {
                  root,
                  runId: rid,
                  environment: 'FIXTURE',
                  autonomy,
                  policy,
                  registryFile: registryFile(root),
                  approvals: new ApprovalStore(join(root, '.qa-memory', 'approvals.jsonl')),
                  ledger,
                  audit: ctx.audit,
                  orgIdForApprovals: readCatalog(root)?.org ?? org.orgId,
                  ...(rerun ? { rerun } : {}),
                  say,
                },
              );
              return res.repairs;
            } finally {
              ledger.close();
            }
          },
        },
      );
      say(
        `Scorecard [${scorecard.environment}]: ${scorecard.correct}/${scorecard.total} correct · assertion changes ${scorecard.assertionChanges} · exit ${scorecard.passed ? 'PASSED' : 'NOT MET'}`,
      );
      for (const f of files) say(`Saved: ${f}`);
      process.exitCode = scorecard.passed ? 0 : 1;
    });
}
