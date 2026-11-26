// `qa run --story <key> --org <alias> [--browser chromium|chrome|msedge] [--cases …] [--plan-only]` — Phase 5 Runner.
// The gate decides what may execute (APPROVED + current specs only; stale → BLOCKED, never run). `--plan-only` stops
// there. Otherwise the run is a graph run seeded at `execute` (src/runner/execute.ts) followed by `report`.
// Exit codes: 0 = every executed test PASS, 1 = a test FAIL / UNCERTAIN / BLOCKED or data not CLEAN, 2 = nothing
// executed, 3 = BLOCKED (hard stop or a human checkpoint such as a missing data approval).
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Command } from 'commander';
import { QAError } from '../core/errors.js';
import { newRunId, runPaths } from '../core/runFolder.js';
import { Autonomy, initialRunState } from '../core/state.js';
import type { QAGraphStateType } from '../graph/state.js';
import { executeStory, MAX_RUN_ID, planStoryExecution } from '../runner/execute.js';
import type { GateItem } from '../runner/gate.js';
import type { Redactor } from '../security/redact.js';
import { createRuntime } from './analyze.js';

type Say = (msg: string) => void;

/** Refresh STALE marks against the latest snapshot, then decide what may execute. */
export async function planExecution(root: string, orgAlias: string, storyKey: string): Promise<GateItem[]> {
  return (await planStoryExecution(root, orgAlias, storyKey)).items;
}

const splitList = (v?: string): string[] | undefined =>
  v
    ?.split(',')
    .map((x) => x.trim())
    .filter(Boolean);

/** Short console summary of an execution (the reports carry the detail). */
export function runSummaryText(v: QAGraphStateType, root: string): string {
  const L: string[] = [];
  const e = v.execution;
  L.push('', `Run ${v.runId} — ${v.status}${e ? ` · ${e.environment} · ${e.orgAlias} · ${e.browser}` : ''}`);
  if (e?.environment && e.environment !== 'LIVE')
    L.push(`  ${e.environment}: results come from the offline fixture — never a real Salesforce pass.`);
  if (v.executionBlockedReason) L.push(`  BLOCKED: ${v.executionBlockedReason}`);
  for (const r of v.results)
    L.push(`  ${r.state.padEnd(9)} ${(r.caseId ?? r.testId).padEnd(15)} ${(r.reason ?? '').split('\n')[0] ?? ''}`);
  if (e) {
    const x = e.executed;
    L.push(
      `  executed: ${x.PASS} PASS · ${x.FAIL} FAIL · ${x.UNCERTAIN} UNCERTAIN · ${x.BLOCKED} BLOCKED · ${x.SKIPPED} SKIPPED (flaky ${e.flaky}) · data ${e.cleanup}`,
    );
  }
  const dir = runPaths(root, v.runId).dir;
  L.push(
    `  results: ${join(dir, 'results.json')}`,
    `  Playwright HTML: ${join(dir, 'playwright-report', 'index.html')}`,
  );
  L.push(`  reporting-labs: ${join(dir, 'reporting-labs')}`, `  run log: ${runPaths(root, v.runId).runLog}`);
  for (const o of v.outputs.filter((f) => f.endsWith('.md'))) L.push(`  report: ${o}`);
  return L.join('\n');
}

export function exitCodeOf(v: QAGraphStateType): number {
  if (v.status === 'BLOCKED') return 3;
  const e = v.execution;
  if (!e || e.gate['EXECUTE'] === 0) return 2;
  const x = e.executed;
  const ok = x.FAIL + x.UNCERTAIN + x.BLOCKED === 0 && x.PASS > 0 && (e.cleanup === 'CLEAN' || e.cleanup === 'NONE');
  return ok ? 0 : 1;
}

export function registerRun(program: Command, rootOf: () => string, say: Say): void {
  program
    .command('run')
    .description('Execute the APPROVED, current specs of a story (Playwright Test runner) and report the results')
    .requiredOption('--story <key>', 'story whose generated specs to run (tests/generated/<key>)')
    .requiredOption('--org <alias>', 'org alias from config/orgs.yaml (fixture = offline fixture, labelled FIXTURE)')
    .option('--browser <name>', 'chromium | chrome | msedge (default: QA_BROWSER, else config/execution.yaml)')
    .option('--cases <ids>', 'run only these APPROVED cases (comma-separated)')
    .option('--autonomy <level>', 'L1 | L2 | L3 (default: policy)')
    .option('--keep-data', 'keep the data the tests create (cleanup becomes KEPT)')
    .option('--plan-only', 'decide and report only; no test is executed')
    .option('--run-id <id>', `run id (default run-<timestamp>, at most ${MAX_RUN_ID} characters)`)
    .action(
      async (o: {
        story: string;
        org: string;
        browser?: string;
        cases?: string;
        autonomy?: string;
        keepData?: boolean;
        planOnly?: boolean;
        runId?: string;
      }) => {
        const root = rootOf();
        const runId = o.runId ?? newRunId('run');
        const cases = splitList(o.cases);
        if (o.planOnly) {
          const { items } = await planStoryExecution(root, o.org, o.story, cases);
          const dir = join(runPaths(root, runId).dir, 'run');
          mkdirSync(dir, { recursive: true });
          writeFileSync(join(dir, 'execution-plan.json'), `${JSON.stringify(items, null, 2)}\n`);
          const count = (d: string): number => items.filter((i) => i.decision === d).length;
          say(
            `Execution plan for ${o.story} on ${o.org}: ${count('EXECUTE')} EXECUTE · ${count('BLOCKED')} BLOCKED · ${count('NOT_APPROVED')} NOT_APPROVED · ${count('MANUAL')} MANUAL`,
          );
          for (const i of items) say(`  ${i.decision.padEnd(12)} ${i.caseId}  ${i.reason}`);
          say(`Saved: ${join(dir, 'execution-plan.json')} (plan only: nothing was executed)`);
          return;
        }
        // The runtime's redactor (secrets from .env / Credential Manager) — set once the runtime exists.
        const red: { r?: Redactor } = {};
        const rt = await createRuntime({
          root,
          say,
          noModels: true,
          logFile: runPaths(root, runId).runLog,
          execute: (s) =>
            executeStory({
              root,
              runId: s.runId,
              storyKey: o.story,
              orgAlias: o.org,
              ...(o.browser ? { browser: o.browser } : {}),
              ...(cases ? { cases } : {}),
              autonomy: s.autonomy,
              ...(o.keepData ? { keepData: true } : {}),
              say,
              redact: (t: string) => red.r?.redactText(t) ?? t,
            }),
        });
        red.r = rt.deps.redactor;
        try {
          if (rt.checkpointer.threads().includes(runId)) {
            throw new QAError(
              'DATA',
              `run id ${runId} already exists in .qa-memory/checkpoints.db — use a new --run-id`,
            );
          }
          const autonomy = Autonomy.parse(o.autonomy ?? rt.env.QA_AUTONOMY ?? rt.policy.autonomy);
          const state = {
            ...initialRunState({
              runId,
              org: o.org,
              autonomy,
              source: { type: 'file' as const, ref: `manifest:tests/generated/${o.story}/manifest.json` },
              storyKey: o.story,
              tokenLimit: 1,
              timeLimitMin: 120,
              inputs: [],
            }),
            executeSeed: true,
            interactive: false,
          };
          say(`Run ${runId} — output in ${runPaths(root, runId).dir}`);
          const config = { configurable: { thread_id: runId } };
          await rt.graph.invoke(state, config);
          const v = (await rt.graph.getState(config)).values as QAGraphStateType;
          process.stdout.write(`${runSummaryText(v, root)}\n`);
          process.exitCode = exitCodeOf(v);
        } finally {
          await rt.close();
        }
      },
    );
}
