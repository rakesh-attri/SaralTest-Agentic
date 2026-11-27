// Phase 5 contracts: the story manifest the Runner reads, execution summaries, release confidence, run history,
// the JIRA comment draft and UI-observed messages (Explorer).
import { z } from 'zod';
import { Environment, IsoDate } from './common.js';
import { GeneratedArtifact } from './generation.js';
import { ResultState } from './result.js';

/** One generated spec in `tests/generated/<story>/manifest.json` (pass-2 rechecks add `buildRun` / `reviewedBy`). */
export const ManifestArtifact = GeneratedArtifact.extend({
  /** Build run that produced this file (partial rebuilds merge artifacts from several builds). */
  buildRun: z.string().optional(),
  /** `qa review --pass 2` run that last re-reviewed it. */
  reviewedBy: z.string().optional(),
});
export type ManifestArtifact = z.infer<typeof ManifestArtifact>;

export const ManualOnlyCase = z.object({ caseId: z.string().min(1), reason: z.string().min(1) });

export const StoryManifest = z.object({
  storyKey: z.string().min(1),
  designRun: z.string().optional(),
  buildRun: z.string().optional(),
  org: z.string().optional(),
  environment: Environment.optional(),
  artifacts: z.array(ManifestArtifact),
  manualOnly: z.array(ManualOnlyCase).default([]),
});
export type StoryManifest = z.infer<typeof StoryManifest>;

export const Browser = z.enum(['chromium', 'chrome', 'msedge']);
export type Browser = z.infer<typeof Browser>;

/** Counts per result state; reports never merge FIXTURE/MOCK counts into LIVE ones. */
export const StateCounts = z.object({
  PASS: z.number().int().nonnegative(),
  FAIL: z.number().int().nonnegative(),
  BLOCKED: z.number().int().nonnegative(),
  SKIPPED: z.number().int().nonnegative(),
  UNCERTAIN: z.number().int().nonnegative(),
});
export type StateCounts = z.infer<typeof StateCounts>;

export const ExecutionSummary = z.object({
  runId: z.string(),
  storyKey: z.string(),
  orgAlias: z.string(),
  environment: Environment,
  browser: Browser,
  /** The browser the operator asked for, when a fallback channel was used instead. */
  requestedBrowser: Browser.optional(),
  startedAt: IsoDate,
  finishedAt: IsoDate,
  /** Gate decisions: EXECUTE / BLOCKED / NOT_APPROVED / MANUAL counts. */
  gate: z.record(z.string(), z.number().int().nonnegative()),
  /** Results of the tests that ran (gate EXECUTE only). */
  executed: StateCounts,
  /** Every row incl. not-run gate rows. */
  all: StateCounts,
  flaky: z.number().int().nonnegative(),
  cleanup: z.enum(['CLEAN', 'INCOMPLETE', 'KEPT', 'NONE']),
  /** Playwright exit code (null = not started). */
  exitCode: z.number().int().nullable(),
  /** Runner outcome: COMPLETE = every selected test reported; BLOCKED = stopped before any test (preflight). */
  status: z.enum(['COMPLETE', 'PARTIAL', 'BLOCKED']).optional(),
  blockedReason: z.string().optional(),
});
export type ExecutionSummary = z.infer<typeof ExecutionSummary>;

export const ReleaseVerdict = z.enum(['Ready', 'Ready with risks', 'Not ready']);
export type ReleaseVerdict = z.infer<typeof ReleaseVerdict>;

export const ReleaseConfidence = z.object({
  verdict: ReleaseVerdict,
  /** One sentence why (reporting skill template, line 1). */
  why: z.string().min(1),
  reasons: z.array(z.string()),
  environment: Environment,
  /** Acceptance criteria covered by executed + passed tests / total. */
  acCoverage: z.object({ covered: z.number().int(), executedPassed: z.number().int(), total: z.number().int() }),
});
export type ReleaseConfidence = z.infer<typeof ReleaseConfidence>;

export const RunHistoryEntry = z.object({
  runId: z.string(),
  storyKey: z.string(),
  orgAlias: z.string(),
  environment: Environment,
  browser: Browser,
  at: IsoDate,
  results: z.array(z.object({ caseId: z.string(), state: ResultState })),
});
export type RunHistoryEntry = z.infer<typeof RunHistoryEntry>;

export const JiraCommentDraft = z.object({
  storyKey: z.string(),
  runId: z.string(),
  /** Plain text / markdown-ish body exactly as it will be posted. */
  text: z.string().min(1),
  /** sha256 of `text`: an approval is bound to this exact text. */
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
  createdAt: IsoDate,
});
export type JiraCommentDraft = z.infer<typeof JiraCommentDraft>;

/** A message text the Explorer observed in the UI (evidence for a message assertion; not a requirement). */
export const ObservedMessage = z.object({
  id: z.string(),
  org: z.string(),
  /** Page id from the locator registry (e.g. contact-new). */
  page: z.string(),
  /** Field API name (Object.Field) the message belongs to, when field-level. */
  field: z.string().optional(),
  kind: z.enum(['required', 'duplicate', 'validation']),
  /** Where it appeared: on the field, on the page/dialog error summary, or as a duplicate alert. */
  placement: z.enum(['field', 'page', 'alert']),
  text: z.string().min(1),
  persona: z.string(),
  snapshotId: z.string(),
  observedAt: IsoDate,
  /** Screenshot path relative to the repo (stays local; never sent to a model). */
  screenshot: z.string().optional(),
  runId: z.string(),
  environment: z.enum(['LIVE', 'FIXTURE']),
  /** For duplicate warnings: the rule and its action as declared in the snapshot. */
  rule: z.string().optional(),
  /**
   * Human acceptance (PLAN §7f: OBSERVED needs review before an assertion relies on it). `text` is the exact text the
   * human confirmed when the stored copy is masked by the redactor (e.g. Salesforce's example email address).
   */
  accepted: z.object({ by: z.string().min(2), at: IsoDate, text: z.string().min(1).optional() }).optional(),
});
export type ObservedMessage = z.infer<typeof ObservedMessage>;
