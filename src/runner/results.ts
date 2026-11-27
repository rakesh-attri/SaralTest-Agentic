// Playwright JSON report → TestResult[] (PLAN.md §4). The JSON is external input: parsed with a lenient Zod schema of
// the fields we use. Mapping (Phase 5 contract):
//   passed → PASS · failed / timedOut → FAIL · passed only on a retry → UNCERTAIN (flaky) · interrupted → UNCERTAIN
//   skipped / fixme → SKIPPED · skipped because the persona's auth setup failed → BLOCKED
//   test steps passed but the data teardown failed (cleanup not CLEAN) → UNCERTAIN
// Gate rows that never ran (NOT_APPROVED / BLOCKED / MANUAL) are added as SKIPPED / BLOCKED rows with the gate reason.
import { relative, sep } from 'node:path';
import { z } from 'zod';
import type { Environment, ResultCleanup, ResultState, TestResult } from '../core/schemas/index.js';
import type { GateItem } from './gate.js';

const Annotation = z.object({ type: z.string(), description: z.string().optional() });
const Attachment = z.object({ name: z.string(), path: z.string().optional(), contentType: z.string().optional() });
const PwResult = z.object({
  status: z.string().optional(),
  duration: z.number().default(0),
  retry: z.number().default(0),
  errors: z.array(z.object({ message: z.string().default('') })).default([]),
  attachments: z.array(Attachment).default([]),
});
const PwTest = z.object({
  projectName: z.string().default(''),
  status: z.enum(['skipped', 'expected', 'unexpected', 'flaky']),
  annotations: z.array(Annotation).default([]),
  results: z.array(PwResult).default([]),
});
const PwSpec = z.object({
  id: z.string(),
  title: z.string(),
  file: z.string(),
  tags: z.array(z.string()).default([]),
  tests: z.array(PwTest).default([]),
});
interface PwSuiteT {
  title: string;
  file?: string | undefined;
  specs: z.infer<typeof PwSpec>[];
  suites?: PwSuiteT[] | undefined;
}
const PwSuite: z.ZodType<PwSuiteT> = z.lazy(() =>
  z.object({
    title: z.string().default(''),
    file: z.string().optional(),
    specs: z.array(PwSpec).default([]),
    suites: z.array(PwSuite).optional(),
  }),
);
export const PlaywrightJson = z.object({
  config: z.looseObject({ rootDir: z.string().optional() }).optional(),
  suites: z.array(PwSuite).default([]),
  errors: z.array(z.object({ message: z.string().default('') })).default([]),
  stats: z.looseObject({ unexpected: z.number().optional(), flaky: z.number().optional() }).optional(),
});
export type PlaywrightJson = z.infer<typeof PlaywrightJson>;

export interface ResultContext {
  runId: string;
  environment: Environment;
  snapshotId: string;
  browser: string;
  /** Root the attachment paths are made relative to (the run folder). */
  runDir: string;
  /** Repo root (spec paths in the report are relative to Playwright's testDir, tests/generated). */
  testDirRel: string;
  gate: readonly GateItem[];
  /** Redact a free-text error before it is stored. */
  redact?: (s: string) => string;
}

function* walk(suites: readonly PwSuiteT[]): Generator<z.infer<typeof PwSpec>> {
  for (const s of suites) {
    yield* s.specs;
    if (s.suites) yield* walk(s.suites);
  }
}

const AUTH_PROJECT = /^auth-(.+)$/;
const firstLines = (s: string, n = 3): string =>
  s
    // eslint-disable-next-line no-control-regex -- strip ANSI colour codes from Playwright error text
    .replace(/\u001b\[[0-9;]*m/g, '')
    .split('\n')
    .filter((l) => l.trim())
    .slice(0, n)
    .join('\n');

/** `CLEAN (0 adopted)` → CLEAN. */
function cleanupOf(annotations: readonly z.infer<typeof Annotation>[]): ResultCleanup | undefined {
  const a = annotations.find((x) => x.type === 'data-cleanup');
  const m = /^(CLEAN|KEPT|INCOMPLETE)\b/.exec(a?.description ?? '');
  return m ? (m[1] as ResultCleanup) : undefined;
}

/** Map one test (all its attempts) to a state + reason. Exported for unit tests. */
export function stateOf(
  t: z.infer<typeof PwTest>,
  authFailure: string | undefined,
): { state: ResultState; reason: string; cleanup: ResultCleanup | undefined } {
  const last = t.results[t.results.length - 1];
  const errors = t.results.flatMap((r) => r.errors.map((e) => e.message));
  const cleanup = cleanupOf(t.annotations);
  if (t.status === 'skipped') {
    if (authFailure) return { state: 'BLOCKED', reason: `persona session not available: ${authFailure}`, cleanup };
    const fixme = t.annotations.find((a) => a.type === 'fixme' || a.type === 'skip');
    return { state: 'SKIPPED', reason: fixme?.description ?? 'skipped by the test', cleanup };
  }
  if (last?.status === 'interrupted')
    return { state: 'UNCERTAIN', reason: 'run interrupted before the test finished', cleanup };
  if (t.status === 'flaky')
    return {
      state: 'UNCERTAIN',
      reason: `passed only on retry ${last?.retry ?? 1} (flaky) — first failure: ${firstLines(errors[0] ?? '', 1)}`,
      cleanup,
    };
  if (t.status === 'expected') {
    if (cleanup === 'INCOMPLETE')
      return { state: 'UNCERTAIN', reason: 'test passed but its data cleanup is INCOMPLETE', cleanup };
    return { state: 'PASS', reason: 'all steps passed', cleanup };
  }
  // unexpected: failed / timedOut. A failure that is only the data teardown is not a product result.
  const lastErrors = last?.errors.map((e) => e.message) ?? [];
  if (lastErrors.length && lastErrors.every((m) => /cleanup (INCOMPLETE|KEPT)/.test(m)))
    return { state: 'UNCERTAIN', reason: `test steps passed but ${firstLines(lastErrors[0] ?? '', 1)}`, cleanup };
  const why = last?.status === 'timedOut' ? 'timed out' : 'failed';
  return {
    state: 'FAIL',
    reason: `${why}: ${firstLines(lastErrors[0] ?? errors[0] ?? 'no error message', 2)}${
      // A retry that failed differently hides the first cause (qa-prod run-p5-live-1, TC-007): keep both.
      t.results.length > 1 && errors[0] && firstLines(errors[0], 1) !== firstLines(lastErrors[0] ?? '', 1)
        ? ` (first attempt: ${firstLines(errors[0], 1)})`
        : ''
    }`,
    cleanup,
  };
}

const caseIdOf = (file: string): string | undefined => /(TC-[A-Z0-9]+-\d+-\d+)/.exec(file)?.[1];
const posix = (p: string): string => p.split(sep).join('/');

export function toTestResults(json: PlaywrightJson, c: ResultContext): TestResult[] {
  const specs = [...walk(json.suites)];
  // Auth-setup failures per persona project (auth-<persona>).
  const authFail = new Map<string, string>();
  for (const s of specs)
    for (const t of s.tests) {
      const m = AUTH_PROJECT.exec(t.projectName);
      if (m?.[1] && t.status === 'unexpected') {
        const msg = t.results[t.results.length - 1]?.errors[0]?.message ?? 'auth setup failed';
        authFail.set(m[1], firstLines(msg, 1));
      }
    }
  const redact = c.redact ?? ((s: string) => s);
  const out: TestResult[] = [];
  const ran = new Set<string>();
  for (const s of specs) {
    for (const t of s.tests) {
      if (AUTH_PROJECT.test(t.projectName)) continue;
      const caseId = caseIdOf(s.file) ?? s.title;
      const { state, reason, cleanup } = stateOf(t, authFail.get(t.projectName));
      const last = t.results[t.results.length - 1];
      const attachments = t.results
        .flatMap((r) => r.attachments)
        .filter((a): a is { name: string; path: string } => typeof a.path === 'string')
        .map((a) => ({ name: a.name, path: posix(relative(c.runDir, a.path)) }));
      const errs = last?.errors.map((e) => e.message) ?? [];
      ran.add(caseId);
      out.push({
        testId: s.id,
        caseId,
        state,
        reason: redact(reason),
        evidenceIds: [],
        environment: c.environment,
        snapshotId: c.snapshotId,
        runId: c.runId,
        specPath: `${c.testDirRel}/${posix(s.file)}`,
        persona: t.projectName,
        browser: c.browser,
        durationMs: t.results.reduce((n, r) => n + r.duration, 0),
        attempts: t.results.length,
        flaky: t.status === 'flaky',
        ...(errs.length ? { errorSummary: redact(firstLines(errs[0] ?? '', 4)) } : {}),
        attachments,
        dataCleanup: cleanup ?? 'NONE',
      });
    }
  }
  // Gate EXECUTE rows the report does not contain (crash before start, list error): never a silent pass.
  for (const g of c.gate) {
    if (ran.has(g.caseId)) continue;
    const state: ResultState =
      g.decision === 'EXECUTE' ? 'UNCERTAIN' : g.decision === 'BLOCKED' ? 'BLOCKED' : 'SKIPPED';
    const reason =
      g.decision === 'EXECUTE'
        ? 'selected for execution but no result in the Playwright report (run did not reach the test)'
        : g.decision === 'MANUAL'
          ? `manual-only: ${g.reason}`
          : g.decision === 'NOT_APPROVED'
            ? `not executed — ${g.reason}`
            : g.reason;
    out.push({
      testId: g.caseId,
      caseId: g.caseId,
      state,
      reason,
      evidenceIds: [],
      environment: c.environment,
      snapshotId: c.snapshotId,
      runId: c.runId,
      ...(g.path ? { specPath: g.path } : {}),
      attachments: [],
    });
  }
  return out.sort((a, b) => (a.caseId ?? a.testId).localeCompare(b.caseId ?? b.testId));
}
