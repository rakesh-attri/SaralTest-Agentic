// Phase 7 contracts: failure investigation, self-healing, defect drafts and fault injection (PLAN.md §4, §11 Phase 7;
// .claude/skills/defect-investigation/SKILL.md). Older state files stay valid: every field added in Phase 7 is optional
// or has a default.
import { z } from 'zod';
import { Environment, IsoDate, Severity } from './common.js';
import { EvalScore } from './result.js';

export const Verdict = z.enum([
  'PRODUCT_DEFECT',
  'PERMISSION_CONFIG',
  'SCRIPT_LOCATOR',
  'SCRIPT_TIMING',
  'TEST_DATA',
  'INVALID_REQUIREMENT_ASSUMPTION',
  'STALE_KNOWLEDGE',
  'ENVIRONMENT',
  'FLAKY',
  'UNKNOWN',
]);
export type Verdict = z.infer<typeof Verdict>;

/** Deterministic facts read from a failed result (error text, attachments, data sub-run) before any model is asked. */
export const SignalKind = z.enum([
  'LOCATOR_NOT_FOUND', // waiting for a locator timed out / element not found
  'LOCATOR_NOT_UNIQUE', // strict mode violation
  'ASSERTION_MISMATCH', // expect(...) received a different value
  'URL_MISMATCH', // toHaveURL failed
  'WAIT_TIMEOUT', // a wait (spinner, toast, load state) ran out
  'HTTP_5XX',
  'LOGIN_PAGE', // session lost: landed on the login page
  'MAINTENANCE', // maintenance / service unavailable page
  'NETWORK_ERROR', // fetch failed, ECONNRESET, ENOTFOUND …
  'DATA_SETUP_FAILED', // the test's own data sub-run failed before the subject step
  'INSUFFICIENT_ACCESS', // CRUD / FLS / sharing error
  'VALIDATION_ERROR', // FIELD_CUSTOM_VALIDATION_EXCEPTION and friends
  'DUPLICATE_RULE', // DUPLICATES_DETECTED
  'PASSED_ON_RETRY', // Playwright retry passed
  'DIFFERENT_FAILURE_ON_RETRY', // the retry failed with another error
  'DATA_NOT_CLEAN', // cleanup INCOMPLETE / KEPT
]);
export type SignalKind = z.infer<typeof SignalKind>;

export const FailureSignal = z.object({
  kind: SignalKind,
  detail: z.string(),
  /** Locator expression quoted in the error (getByRole('button', { name: 'Save' }) …). */
  locator: z.string().optional(),
  expected: z.string().optional(),
  received: z.string().optional(),
  /** test.step title in which the failure happened. */
  step: z.string().optional(),
  /** Salesforce error code (FIELD_CUSTOM_VALIDATION_EXCEPTION, INSUFFICIENT_ACCESS_OR_READONLY …). */
  sfErrorCode: z.string().optional(),
  /** Where the fact came from: error | attachment:<name> | data | retry. */
  source: z.string(),
});
export type FailureSignal = z.infer<typeof FailureSignal>;

/** Fixed experiment catalog. Cheapest first; only `rerun-*` and `api-reproduce` may write (through the guard). */
export const ExperimentKind = z.enum([
  'requirement-trace', // where did the failing expectation come from (evidence level, assumption, decision)?
  'identity-probe', // org + user + instance still match
  'health-probe', // REST reachable, no maintenance / 5xx
  'soql-ledger', // the records the test created: exist, field values, parents
  'snapshot-diff', // components changed since the spec was built
  'validation-rule-check', // active validation rules on the object (the data plan's fields)
  'permission-check', // ObjectPermissions / UserRecordAccess for the persona
  'aria-locate', // open the page, look for the failed element in the ARIA tree (observe only)
  'rerun-fresh-data', // run the same test again with fresh data, same persona
  'rerun-extended-waits', // run again with longer waits (timing hypothesis)
  'flaky-reruns', // N reruns without changes (flaky hypothesis)
  'api-reproduce', // do the failing action through the REST API (excludes UI causes)
]);
export type ExperimentKind = z.infer<typeof ExperimentKind>;

export const ExperimentOutcome = z.enum(['SUPPORTS', 'REFUTES', 'INCONCLUSIVE', 'ERROR', 'SKIPPED']);
export type ExperimentOutcome = z.infer<typeof ExperimentOutcome>;

export const Experiment = z.object({
  id: z.string(),
  kind: ExperimentKind,
  action: z.enum(['observe', 'mutate']),
  /** The question the experiment answers, in plain words. */
  question: z.string(),
  hypothesisIds: z.array(z.string()).default([]),
  outcome: ExperimentOutcome,
  /** Short, redacted result text. */
  result: z.string(),
  /** Small structured facts (counts, ids, verdict hints). Redacted; no record data beyond ids. */
  data: z.record(z.string(), z.unknown()).default({}),
  evidenceIds: z.array(z.string()).default([]),
  at: IsoDate,
});
export type Experiment = z.infer<typeof Experiment>;

/** Who owns the next step for a verdict (defect-investigation SKILL taxonomy). */
export const InvestigationRoute = z.enum([
  'self-healer',
  'defect-judge',
  'test-data',
  'spec-analyst',
  're-discover',
  'quarantine',
  'qa-lead',
]);
export type InvestigationRoute = z.infer<typeof InvestigationRoute>;

export const ROUTE_OF: Record<Verdict, InvestigationRoute> = {
  PRODUCT_DEFECT: 'defect-judge',
  PERMISSION_CONFIG: 'defect-judge',
  SCRIPT_LOCATOR: 'self-healer',
  SCRIPT_TIMING: 'self-healer',
  TEST_DATA: 'test-data',
  INVALID_REQUIREMENT_ASSUMPTION: 'spec-analyst',
  STALE_KNOWLEDGE: 're-discover',
  ENVIRONMENT: 'qa-lead',
  FLAKY: 'quarantine',
  UNKNOWN: 'qa-lead',
};

export const Hypothesis = z.object({
  id: z.string(),
  text: z.string(),
  /** The discriminating check for this hypothesis. */
  test: z.string(),
  result: z.string().optional(),
  evidenceIds: z.array(z.string()),
  // ---- Phase 7
  verdict: Verdict.optional(),
  status: z.enum(['OPEN', 'SUPPORTED', 'REFUTED', 'INCONCLUSIVE']).optional(),
});
export type Hypothesis = z.infer<typeof Hypothesis>;

export const Investigation = z.object({
  failureId: z.string(),
  observations: z.array(z.string()),
  hypotheses: z.array(Hypothesis),
  verdict: Verdict,
  confidence: z.number().min(0).max(1),
  status: z.enum(['SUSPECTED', 'CONFIRMED']),
  // ---- Phase 7 (optional so Phase 0–6 state stays valid)
  runId: z.string().optional(),
  caseId: z.string().optional(),
  testId: z.string().optional(),
  specPath: z.string().optional(),
  persona: z.string().optional(),
  environment: Environment.optional(),
  signals: z.array(FailureSignal).default([]),
  experiments: z.array(Experiment).default([]),
  /** rule = a deterministic rule decided; model = the reasoning model decided within the allowed verdicts. */
  verdictBy: z.enum(['rule', 'model', 'rule+model']).optional(),
  /** Id of the deterministic rule that decided (R-ENV-1 …). */
  rule: z.string().optional(),
  route: InvestigationRoute.optional(),
  rationale: z.string().optional(),
  evidenceIds: z.array(z.string()).default([]),
  /** Model that answered (with fallback flag), or 'none' when no model was used. */
  model: z.string().optional(),
  createdAt: IsoDate.optional(),
});
export type Investigation = z.infer<typeof Investigation>;

// ---------------------------------------------------------------- defects

export const Reproduction = z.object({
  via: z.enum(['UI', 'API']),
  runId: z.string(),
  outcome: z.enum(['REPRODUCED', 'NOT_REPRODUCED', 'ERROR']),
  freshData: z.boolean(),
  persona: z.string(),
  detail: z.string(),
  evidenceIds: z.array(z.string()).default([]),
  at: IsoDate,
});
export type Reproduction = z.infer<typeof Reproduction>;

/** Deterministic part of the Defect Judge standard; every item must be true before CONFIRMED. */
export const JudgeGate = z.object({
  reproducedTwiceFreshData: z.boolean(),
  reproducedViaApi: z.boolean(),
  testDataRuledOut: z.boolean(),
  environmentRuledOut: z.boolean(),
  requirementTraced: z.boolean(),
  evidenceResolves: z.boolean(),
  sanitized: z.boolean(),
  /** Gate items that failed, in plain words. */
  missing: z.array(z.string()).default([]),
});
export type JudgeGate = z.infer<typeof JudgeGate>;

export const JudgeReview = z.object({
  gate: JudgeGate,
  /** Judge model's claim-by-claim check (claims not backed by an evidence id). */
  unsupportedClaims: z.array(z.string()).default([]),
  /** Model that judged (must differ from the coder model). 'none' when the judge was unavailable. */
  model: z.string(),
  decision: z.enum(['CONFIRMED', 'SUSPECTED', 'REJECTED']),
  reason: z.string(),
  at: IsoDate,
});
export type JudgeReview = z.infer<typeof JudgeReview>;

export const DefectDraft = z.object({
  id: z.string(),
  failureId: z.string(),
  title: z.string(),
  stepsToReproduce: z.array(z.string()),
  expected: z.string(),
  actual: z.string(),
  evidenceIds: z.array(z.string()).min(1),
  severity: z.string(),
  published: z.boolean(),
  // ---- Phase 7: Defect Judge standard fields
  status: z.enum(['SUSPECTED', 'CONFIRMED']).optional(),
  verdict: Verdict.optional(),
  runId: z.string().optional(),
  caseId: z.string().optional(),
  storyKey: z.string().optional(),
  requirementRefs: z.array(z.string()).default([]),
  environment: Environment.optional(),
  org: z.string().optional(),
  orgProfile: z.string().optional(),
  persona: z.string().optional(),
  preconditions: z.array(z.string()).default([]),
  dataScope: z.string().optional(),
  reproductions: z.array(Reproduction).default([]),
  apiEvidence: z.array(z.string()).default([]),
  attachments: z.array(z.object({ name: z.string(), path: z.string() })).default([]),
  components: z.array(z.string()).default([]),
  duplicates: z.array(z.string()).default([]),
  hypotheses: z.array(z.string()).default([]),
  suggestedRegressionTests: z.array(z.string()).default([]),
  severityLevel: Severity.optional(),
  severityRationale: z.string().optional(),
  judge: JudgeReview.optional(),
  /** DeepEval faithfulness (Phase 8). Until then UNEVALUATED → a human must review. */
  faithfulness: EvalScore.optional(),
  /** sha256 of the rendered bug text; approvals and publication are bound to it. */
  sha256: z.string().optional(),
  publication: z
    .object({ key: z.string(), url: z.string().optional(), via: z.enum(['mcp', 'rest']), at: IsoDate })
    .optional(),
  createdAt: IsoDate.optional(),
});
export type DefectDraft = z.infer<typeof DefectDraft>;

// ---------------------------------------------------------------- self-healing

/** Locator facts that a repair may change (registry row view). */
export const LocatorFacts = z.object({
  page: z.string(),
  element: z.string(),
  persona: z.string(),
  expression: z.string(),
  role: z.string().optional(),
  accessibleName: z.string().optional(),
  strategy: z.string().optional(),
  fieldApiName: z.string().optional(),
});
export type LocatorFacts = z.infer<typeof LocatorFacts>;

/** Every expect / oracle call of a spec (+ IR assertions), hashed; equal before and after a repair (rule 7). */
export const AssertionFingerprint = z.object({
  sha256: z.string(),
  count: z.number().int().nonnegative(),
  /** Normalised assertion lines, kept so a refusal can show what differed. */
  items: z.array(z.string()),
});
export type AssertionFingerprint = z.infer<typeof AssertionFingerprint>;

export const HealRepair = z.object({
  id: z.string(),
  runId: z.string(),
  caseId: z.string(),
  specPath: z.string(),
  failureId: z.string(),
  kind: z.enum(['locator', 'wait', 'navigation']),
  locatorBefore: LocatorFacts.optional(),
  locatorAfter: LocatorFacts.optional(),
  /** Wait repairs: which helper / step and the timeouts. */
  waitBefore: z.object({ target: z.string(), timeoutMs: z.number().int().positive() }).optional(),
  waitAfter: z.object({ target: z.string(), timeoutMs: z.number().int().positive() }).optional(),
  fingerprintBefore: AssertionFingerprint,
  fingerprintAfter: AssertionFingerprint,
  assertionsUnchanged: z.boolean(),
  /** Role changed or accessible name not similar → human checkpoint behaviour-changing-locator-repairs. */
  behaviourChanging: z.boolean(),
  reason: z.string(),
  approvalId: z.string().optional(),
  status: z.enum(['PROPOSED', 'APPLIED', 'VERIFIED', 'FAILED', 'REFUSED', 'REVERTED']),
  verification: z.object({ runId: z.string(), state: z.string(), attempts: z.number().int() }).optional(),
  revertOf: z.string().optional(),
  attempt: z.number().int().positive().default(1),
  environment: Environment,
  createdAt: IsoDate,
});
export type HealRepair = z.infer<typeof HealRepair>;

// ---------------------------------------------------------------- fault injection

export const FaultCase = z.object({
  id: z.string(),
  title: z.string(),
  /** Fixture fault key(s) applied by `qa fixture serve --faults` (see src/fixture/faults.ts). */
  inject: z.record(z.string(), z.unknown()),
  /** Case to run against the faulty fixture. */
  caseId: z.string(),
  expectedVerdict: Verdict,
  /** Script faults must be healed with assertions unchanged. */
  expectHeal: z.boolean().default(false),
});
export type FaultCase = z.infer<typeof FaultCase>;

export const FaultSuite = z.object({
  id: z.string(),
  environment: Environment,
  description: z.string().optional(),
  faults: z.array(FaultCase).min(1),
});
export type FaultSuite = z.infer<typeof FaultSuite>;

export const FaultOutcome = z.object({
  faultId: z.string(),
  expectedVerdict: Verdict,
  actualVerdict: Verdict.nullable(),
  correct: z.boolean(),
  confidence: z.number().min(0).max(1).nullable(),
  runId: z.string(),
  testState: z.string(),
  healed: z.boolean().optional(),
  assertionsUnchanged: z.boolean().optional(),
  note: z.string().optional(),
});
export type FaultOutcome = z.infer<typeof FaultOutcome>;

export const FaultScorecard = z.object({
  suiteId: z.string(),
  runId: z.string(),
  environment: Environment,
  total: z.number().int(),
  correct: z.number().int(),
  outcomes: z.array(FaultOutcome),
  assertionChanges: z.number().int(),
  /** PLAN exit: ≥ 80 % correct (4/5) and no assertion changed by the healer. */
  passed: z.boolean(),
  createdAt: IsoDate,
});
export type FaultScorecard = z.infer<typeof FaultScorecard>;
