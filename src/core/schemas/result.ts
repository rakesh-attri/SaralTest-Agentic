import { z } from 'zod';
import { Environment, IsoDate } from './common.js';

export const ResultState = z.enum(['PASS', 'FAIL', 'BLOCKED', 'SKIPPED', 'UNCERTAIN']);
export type ResultState = z.infer<typeof ResultState>;

/** Data cleanup outcome of the test's own data sub-run (NONE = the test created no data). */
export const ResultCleanup = z.enum(['CLEAN', 'KEPT', 'INCOMPLETE', 'NONE']);
export type ResultCleanup = z.infer<typeof ResultCleanup>;

export const TestResult = z.object({
  testId: z.string(),
  state: ResultState,
  reason: z.string().optional(),
  evidenceIds: z.array(z.string()),
  /** environment !== 'LIVE' must be labelled as such in every report. */
  environment: Environment,
  snapshotId: z.string(),
  runId: z.string(),
  // ---- Phase 5 runner detail (optional: older results.json files stay valid)
  /** Test case id (TC-…); testId is the Playwright test id when the test ran, else the case id. */
  caseId: z.string().optional(),
  /** Repo-relative spec path (forward slashes). */
  specPath: z.string().optional(),
  persona: z.string().optional(),
  /** Browser the test actually ran in: chromium | chrome | msedge. */
  browser: z.string().optional(),
  durationMs: z.number().nonnegative().optional(),
  /** Number of attempts Playwright made (1 = no retry). */
  attempts: z.number().int().nonnegative().optional(),
  /** Passed only on a retry: reported as UNCERTAIN, never as a clean pass. */
  flaky: z.boolean().optional(),
  /** First error line(s), redacted. */
  errorSummary: z.string().optional(),
  /** Trace / screenshot / video / data-cleanup paths, relative to the run folder. */
  attachments: z.array(z.object({ name: z.string(), path: z.string() })).default([]),
  dataCleanup: ResultCleanup.optional(),
  // ---- Phase 7: failure detail for the Failure Investigator (redacted; FAIL / UNCERTAIN rows only)
  failure: z
    .object({
      /** One entry per attempt: first error of that attempt (ANSI stripped, ≤ 25 lines, redacted). */
      attempts: z.array(
        z.object({
          attempt: z.number().int().nonnegative(),
          status: z.string(),
          message: z.string(),
          /** Repo-relative file:line where Playwright located the error (helper or spec). */
          location: z.string().optional(),
          /** First stack frame inside the spec file (spec:line). */
          specLine: z.string().optional(),
          /** test.step title that failed (innermost). */
          failedStep: z.string().optional(),
        }),
      ),
      /** Top-level test.step titles of the last attempt with their outcome. */
      steps: z.array(z.object({ title: z.string(), ok: z.boolean() })).default([]),
      /** Run-relative paths of the last attempt's artifacts. */
      errorContext: z.string().optional(),
      trace: z.string().optional(),
      screenshot: z.string().optional(),
    })
    .optional(),
});
export type TestResult = z.infer<typeof TestResult>;
export type FailureDetail = NonNullable<TestResult['failure']>;

export const EvidenceEntry = z.object({
  id: z.string(),
  claim: z.string(),
  sources: z.array(z.string()).min(1),
  agent: z.string(),
  confidence: z.number().min(0).max(1),
  environment: Environment,
  createdAt: IsoDate,
});
export type EvidenceEntry = z.infer<typeof EvidenceEntry>;

export const EvalScore = z.object({
  metric: z.string(),
  score: z.number().nullable(),
  threshold: z.number().optional(),
  status: z.enum(['PASS', 'FAIL', 'UNEVALUATED']),
  detail: z.string().optional(),
});
export type EvalScore = z.infer<typeof EvalScore>;
