// Runner (PLAN.md §3, Phase 5): executes the APPROVED, current specs of a story with the Playwright Test runner
// (CLAUDE.md rule 5 — never step by step through MCP). No LLM. Order:
//   gate (stale → BLOCKED, not approved → not run) → identity check (HARD_STOP) → browser resolution (fallback
//   recorded) → persona browser sessions (base URL = landed host) → recipe approvals (missing → BLOCKED before any
//   test) → `playwright test` → results.json (TestResult[]) → post-run data reconciliation → execution summary.
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { projectPaths, requireConfig } from '../config/loader.js';
import type { OrgEntry } from '../config/schemas.js';
import { QAError } from '../core/errors.js';
import { runPaths } from '../core/runFolder.js';
import type { CreatedRecord } from '../core/schemas/data.js';
import {
  StoryManifest,
  type Browser,
  type ExecutionSummary,
  type ManifestArtifact,
  type StateCounts,
} from '../core/schemas/execution.js';
import type { Environment, ResultState, TestResult } from '../core/schemas/index.js';
import type { Autonomy } from '../core/state.js';
import { storyManifestFile } from '../agents/test-generator/staleness.js';
import { markStaleSpecs } from '../cli/discover.js';
import { SnapshotStore } from '../knowledge/snapshotStore.js';
import type { SfContext } from '../sf/context.js';
import { SnapshotFacts } from '../sf/data/plan.js';
import { run as defaultSpawn, type Runner } from '../util/exec.js';
import type { BrowserChoice, BrowserProbe } from './browser.js';
import { preflight } from './preflight.js';
import { executionPlan, type GateItem } from './gate.js';
import { reconcileRun, type ReconcileReport } from './reconcile.js';
import { PlaywrightJson, toTestResults } from './results.js';

type Say = (msg: string) => void;

/** Max run id length: the data fixture's run tag is `<runId>-<6 hex>` in a 50-character field. */
export const MAX_RUN_ID = 40;

export interface ExecutePlan {
  items: GateItem[];
  snapshotId: string;
  org: OrgEntry;
  manifest: StoryManifest;
  /** Why staleness was (not) re-checked for this org. */
  stalenessNote: string;
}

/** Refresh STALE marks against the org's latest snapshot, then decide what may execute. */
export async function planStoryExecution(
  root: string,
  orgAlias: string,
  storyKey: string,
  cases?: readonly string[],
): Promise<ExecutePlan> {
  const orgs = await requireConfig('orgs', projectPaths(root));
  const org = orgs.orgs.find((x) => x.alias === orgAlias);
  if (!org) throw new QAError('ENVIRONMENT', `org alias "${orgAlias}" is not in config/orgs.yaml`);
  const file = storyManifestFile(root, storyKey);
  if (!existsSync(file)) throw new QAError('DATA', `no generated specs for ${storyKey}`, { fix: 'run qa build first' });
  // Specs record the hashes of the org they were BUILT for (manifest.org). Staleness is re-checked only against that
  // org's latest snapshot: another org (e.g. the offline fixture) has different hashes for the same components, and
  // its snapshot must never write STALE marks into the committed manifest. Other orgs use the marks as they are.
  const builtFor = StoryManifest.parse(JSON.parse(readFileSync(file, 'utf8'))).org;
  const store = new SnapshotStore(join(root, '.qa-memory', 'knowledge.db'));
  let snapshotId: string;
  let stalenessNote: string;
  try {
    const info = store.latest(org.orgId);
    const snap = info ? store.get(info.id) : undefined;
    if (!snap) throw new QAError('DATA', `no snapshot for ${orgAlias}`, { fix: `pnpm qa discover --org ${orgAlias}` });
    snapshotId = snap.info.id;
    if (!builtFor || builtFor === orgAlias) {
      markStaleSpecs(root, org.orgId, new SnapshotFacts(snap), orgAlias);
      stalenessNote = `staleness re-checked against ${orgAlias} snapshot ${snapshotId}`;
    } else {
      stalenessNote = `specs were built for ${builtFor}: staleness is tracked against ${builtFor} (marks used as they are), not re-checked against ${orgAlias}`;
    }
  } finally {
    store.close();
  }
  const manifest = StoryManifest.parse(JSON.parse(readFileSync(file, 'utf8')));
  let items = executionPlan(manifest);
  if (cases?.length) {
    const want = new Set(cases);
    const unknown = cases.filter((c) => !items.some((i) => i.caseId === c));
    if (unknown.length) throw new QAError('DATA', `unknown case id(s) for ${storyKey}: ${unknown.join(', ')}`);
    items = items.map((i) =>
      i.decision === 'EXECUTE' && !want.has(i.caseId)
        ? { ...i, decision: 'NOT_SELECTED', reason: 'not selected for this run (--cases)' }
        : i,
    );
  }
  return { items, snapshotId, org, manifest, stalenessNote };
}

export interface ExecuteOptions {
  root: string;
  runId: string;
  storyKey: string;
  orgAlias: string;
  /** --browser (else QA_BROWSER, else config/execution.yaml). */
  browser?: string;
  cases?: readonly string[];
  autonomy?: Autonomy;
  /** Keep the data of this run (QA_KEEP_DATA=1): cleanup becomes KEPT. */
  keepData?: boolean;
  say: Say;
  /** Echo Playwright's own output to the console (default true). */
  echo?: boolean;
  timeoutMs?: number;
  redact?: (s: string) => string;
}

export interface ExecuteDeps {
  probe?: BrowserProbe;
  spawn?: Runner;
  createContext?: (o: { root: string; runId: string; orgAlias: string; personaId?: string }) => Promise<SfContext>;
  /** Browser session for a persona (default: ensureStorageState). */
  ensureSession?: (ctx: SfContext, browser: Browser) => Promise<{ landedHost: string; reused: boolean }>;
}

export interface ExecutionOutcome {
  status: 'COMPLETE' | 'PARTIAL' | 'BLOCKED';
  /** Why the run stopped before executing (preflight). */
  blockedReason?: string;
  gate: GateItem[];
  results: TestResult[];
  summary: ExecutionSummary;
  reconcile?: ReconcileReport;
  browser?: BrowserChoice;
  dataLedger: CreatedRecord[];
  environment: Environment;
  snapshotId: string;
  files: string[];
}

const PERSONA_TAG = /@persona:([a-z0-9-]+)/g;

export function personasOf(root: string, specPath: string): string[] {
  const text = readFileSync(join(root, specPath), 'utf8');
  return [...new Set([...text.matchAll(PERSONA_TAG)].map((m) => m[1] ?? ''))].filter(Boolean);
}

export function countStates(rows: readonly { state: ResultState }[]): StateCounts {
  const c: StateCounts = { PASS: 0, FAIL: 0, BLOCKED: 0, SKIPPED: 0, UNCERTAIN: 0 };
  for (const r of rows) c[r.state]++;
  return c;
}

const json = (file: string, v: unknown): string => {
  writeFileSync(file, `${JSON.stringify(v, null, 2)}\n`, 'utf8');
  return file;
};

export async function executeStory(o: ExecuteOptions, d: ExecuteDeps = {}): Promise<ExecutionOutcome> {
  if (o.runId.length > MAX_RUN_ID) {
    throw new QAError('DATA', `run id "${o.runId}" is longer than ${MAX_RUN_ID} characters (run tags are 50 chars)`);
  }
  const say = o.say;
  const startedAt = new Date().toISOString();
  const paths = runPaths(o.root, o.runId);
  const runDir = paths.dir;
  const outDir = join(runDir, 'run');
  mkdirSync(outDir, { recursive: true });
  mkdirSync(paths.logs, { recursive: true });
  const files: string[] = [];

  // 1. gate
  const plan = await planStoryExecution(o.root, o.orgAlias, o.storyKey, o.cases);
  const environment: Environment = plan.org.environment;
  files.push(json(join(outDir, 'execution-plan.json'), plan.items));
  const n = (dec: string): number => plan.items.filter((i) => i.decision === dec).length;
  say(
    `Gate for ${o.storyKey} on ${o.orgAlias} (${environment}): ${n('EXECUTE')} EXECUTE · ${n('BLOCKED')} BLOCKED · ${n('NOT_APPROVED')} NOT_APPROVED · ${n('MANUAL')} MANUAL${n('NOT_SELECTED') ? ` · ${n('NOT_SELECTED')} NOT_SELECTED` : ''}`,
  );
  for (const i of plan.items) say(`  ${i.decision.padEnd(12)} ${i.caseId}  ${i.reason}`);
  say(`  (${plan.stalenessNote})`);
  const toRun = plan.items.filter((i) => i.decision === 'EXECUTE' && i.path);
  const byPath = new Map<string, ManifestArtifact>(plan.manifest.artifacts.map((a) => [a.path, a]));

  const outcome = (
    status: ExecutionOutcome['status'],
    results: TestResult[],
    extra: Partial<ExecutionOutcome> & { browser?: BrowserChoice; exitCode?: number | null },
  ): ExecutionOutcome => {
    const ran = results.filter((r) => toRun.some((t) => t.caseId === r.caseId));
    const summary: ExecutionSummary = {
      runId: o.runId,
      storyKey: o.storyKey,
      orgAlias: o.orgAlias,
      environment,
      browser: extra.browser?.browser ?? 'chromium',
      ...(extra.browser && extra.browser.requested !== extra.browser.browser
        ? { requestedBrowser: extra.browser.requested }
        : {}),
      startedAt,
      finishedAt: new Date().toISOString(),
      gate: Object.fromEntries(['EXECUTE', 'BLOCKED', 'NOT_APPROVED', 'MANUAL', 'NOT_SELECTED'].map((k) => [k, n(k)])),
      executed: countStates(ran),
      all: countStates(results),
      flaky: results.filter((r) => r.flaky).length,
      cleanup: extra.reconcile?.status ?? 'NONE',
      exitCode: extra.exitCode ?? null,
      status,
      ...(extra.blockedReason ? { blockedReason: extra.blockedReason } : {}),
    };
    files.push(json(join(runDir, 'results.json'), results));
    files.push(json(join(outDir, 'execution-summary.json'), summary));
    if (extra.reconcile) files.push(json(join(outDir, 'data-reconciliation.json'), extra.reconcile));
    return {
      status,
      gate: plan.items,
      results,
      summary,
      environment,
      snapshotId: plan.snapshotId,
      dataLedger: extra.reconcile?.subRuns.flatMap((s) => s.created) ?? [],
      files,
      ...(extra.reconcile ? { reconcile: extra.reconcile } : {}),
      ...(extra.browser ? { browser: extra.browser } : {}),
      ...(extra.blockedReason ? { blockedReason: extra.blockedReason } : {}),
    };
  };
  const notRunRows = (why: string): TestResult[] =>
    toTestResults(
      { suites: [], errors: [] },
      {
        runId: o.runId,
        environment,
        snapshotId: plan.snapshotId,
        browser: '-',
        runDir,
        testDirRel: 'tests/generated',
        gate: plan.items.map((i) => (i.decision === 'EXECUTE' ? { ...i, decision: 'BLOCKED', reason: why } : i)),
      },
    );

  if (!toRun.length) {
    say('Nothing to execute: no APPROVED, current spec passed the gate.');
    return outcome('PARTIAL', notRunRows('not executed'), {});
  }

  // 2–5. identity → browser → persona sessions → recipe approvals (src/runner/preflight.ts)
  const personas = [...new Set(toRun.flatMap((t) => personasOf(o.root, t.path ?? '')))];
  if (!personas.length) throw new QAError('DATA', 'approved specs carry no @persona:<id> tag');
  const recipes = [...new Set(toRun.flatMap((t) => byPath.get(t.path ?? '')?.dataBindings ?? []))];
  const pre = await preflight(
    {
      root: o.root,
      runId: o.runId,
      orgAlias: o.orgAlias,
      personas,
      recipes,
      ...(o.browser ? { browser: o.browser } : {}),
      ...(o.autonomy ? { autonomy: o.autonomy } : {}),
      say,
    },
    d,
  );
  if (!pre.ok)
    return outcome('BLOCKED', notRunRows(pre.why), {
      ...(pre.browser ? { browser: pre.browser } : {}),
      blockedReason: pre.why,
    });
  const { ctx, sf, browser, baseURL, autonomy, projects } = pre;

  // 6. Playwright Test runner
  // Spec file filters first: `--project` takes a variadic list and would swallow anything after it.
  const args = [
    'playwright',
    'test',
    ...toRun.map((t) => basename(t.path ?? '')),
    ...projects.flatMap((p) => ['--project', p]),
  ];
  const env: Record<string, string> = {
    QA_ORG: o.orgAlias,
    QA_RUN_ID: o.runId,
    QA_RUN_DIR: runDir,
    QA_STORY_KEY: o.storyKey,
    QA_BROWSER: browser.browser,
    QA_AUTONOMY: autonomy,
    QA_ENVIRONMENT: environment,
    QA_SNAPSHOT_ID: plan.snapshotId,
    ...(ctx.env.JIRA_BASE_URL && !/<[^>]+>/.test(ctx.env.JIRA_BASE_URL)
      ? { QA_JIRA_BASE_URL: ctx.env.JIRA_BASE_URL }
      : {}),
    SF_BASE_URL: baseURL,
    ...(o.keepData ? { QA_KEEP_DATA: '1' } : {}),
  };
  say(`Running ${toRun.length} spec(s) as ${projects.join(', ')} on ${baseURL} …`);
  appendFileSync(paths.runLog, `\n# npx ${args.join(' ')}\n`);
  const res = await (d.spawn ?? defaultSpawn)('npx', args, {
    cwd: o.root,
    env,
    timeoutMs: o.timeoutMs ?? 60 * 60_000,
    onOutput: (chunk) => {
      appendFileSync(paths.runLog, chunk);
      if (o.echo !== false) process.stdout.write(chunk);
    },
  });
  if (res.error) say(`Playwright process: ${res.error}`);

  // 7. results
  const pwFile = join(runDir, 'playwright-results.json');
  let results: TestResult[];
  const reported = existsSync(pwFile);
  if (reported) {
    const parsed = PlaywrightJson.safeParse(JSON.parse(readFileSync(pwFile, 'utf8')));
    if (!parsed.success) throw new QAError('UNKNOWN', `unreadable Playwright JSON report: ${parsed.error.message}`);
    results = toTestResults(parsed.data, {
      runId: o.runId,
      environment,
      snapshotId: plan.snapshotId,
      browser: browser.browser,
      runDir,
      testDirRel: 'tests/generated',
      gate: plan.items,
      repoRoot: o.root,
      ...(o.redact ? { redact: o.redact } : {}),
    });
  } else {
    results = notRunRows(`Playwright wrote no report (exit ${String(res.code)}${res.error ? `, ${res.error}` : ''})`);
  }
  if (browser.fallbackReason)
    results = results.map((r) =>
      r.browser && r.browser !== '-'
        ? { ...r, reason: `${r.reason ?? ''} [browser fallback: ${browser.fallbackReason}]` }
        : r,
    );

  // 8. data reconciliation (every sub-run, then a run-wide re-query by tag prefix)
  say('Reconciling test data (every test sub-run, then a run-wide re-query) …');
  const reconcile = await reconcileRun({
    runId: o.runId,
    runDir,
    org: ctx.org,
    sf,
    ...(o.keepData ? { keep: true } : {}),
    window: { userId: sf.identity.userId, since: startedAt },
  });
  say(
    `  data: ${reconcile.status} — ${reconcile.subRuns.length} sub-run(s), ${reconcile.remaining.length} record(s) remaining, ${reconcile.untagged.length} untagged record(s) created during the run`,
  );
  const ran = results.filter((r) => toRun.some((t) => t.caseId === r.caseId));
  // COMPLETE = Playwright reported every selected test with a definite outcome and the data is accounted for.
  const definite = (r: TestResult): boolean =>
    r.state === 'PASS' || r.state === 'FAIL' || r.state === 'SKIPPED' || r.flaky === true;
  const status: ExecutionOutcome['status'] =
    reported && ran.length > 0 && ran.every(definite) && reconcile.status !== 'INCOMPLETE' ? 'COMPLETE' : 'PARTIAL';
  return outcome(status, results, { browser, reconcile, exitCode: res.code });
}
