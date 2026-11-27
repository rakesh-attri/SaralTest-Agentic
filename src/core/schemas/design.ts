import { z } from 'zod';
import { EvidenceLevel, RegressionTier, TestType } from './testCase.js';

/**
 * Phase 3 test-design contracts (PLAN.md §11 P3, test-design skill). Everything here except free-text wording is
 * computed by code: obligations, risk scores, tiers and finding status are deterministic.
 */

export const ImpactLevel = z.enum(['H', 'M', 'L']);
export type ImpactLevel = z.infer<typeof ImpactLevel>;

/** One reason a risk is more likely, kept as evidence (e.g. `org CONFLICT OC-003`, `MTC-006 failed last run`). */
export const RiskDriver = z.object({
  kind: z.enum([
    'org-conflict',
    'org-not-found',
    'org-unknown',
    're-verify',
    'changed-component',
    'manual-test-failed',
    'past-defect',
    'review-required',
    'requirement-risk',
  ]),
  text: z.string(),
  /** Evidence ids / asset ids backing the driver. */
  refs: z.array(z.string()).default([]),
  weight: z.number().min(0).max(1),
});
export type RiskDriver = z.infer<typeof RiskDriver>;

export const RiskItem = z.object({
  id: z.string().regex(/^RISK-\d{2,}$/),
  desc: z.string(),
  likelihood: z.number().min(0).max(1),
  impact: ImpactLevel,
  /** likelihood × impact weight (H=1, M=0.6, L=0.3), rounded to 2 decimals. */
  score: z.number().min(0).max(1),
  tier: RegressionTier,
  drivers: z.array(RiskDriver),
  requirementIds: z.array(z.string()),
  refs: z.array(z.string()).default([]),
  /** Graph node ids (`Field:Contact.Phone`) the risk touches. */
  components: z.array(z.string()).default([]),
});
export type RiskItem = z.infer<typeof RiskItem>;

/** Test charter (test-design skill "Charter first"). */
export const TestCharter = z.object({
  storyKey: z.string().optional(),
  mission: z.string(),
  scope: z.array(z.string()),
  outOfScope: z.array(z.string()),
  personas: z.array(z.object({ id: z.string(), available: z.boolean(), note: z.string().optional() })),
  risks: z.array(z.string()),
  testTypes: z.array(TestType),
  exitCriteria: z.array(z.string()),
  snapshotId: z.string().optional(),
  environment: z.enum(['LIVE', 'FIXTURE', 'MOCK', 'NONE']).default('NONE'),
});
export type TestCharter = z.infer<typeof TestCharter>;

export const ImpactItemOut = z.object({ node: z.string(), depth: z.number().int(), path: z.array(z.string()) });

/** Impact report (Impact & Risk Analyst). Old Phase 2 fields kept; new ones default to empty. */
export const ImpactReport = z.object({
  dependencies: z.array(z.string()),
  regressionCandidates: z.array(z.string()),
  riskScores: z.record(z.string(), z.number()),
  /** Components changed in the last diff (`ValidationRule:Contact.X`). */
  changed: z.array(z.string()).default([]),
  impacted: z.array(ImpactItemOut).default([]),
  /** Open RE_VERIFY marks (`manual-test:MTC-001`). */
  reverify: z.array(z.string()).default([]),
});
export type ImpactReport = z.infer<typeof ImpactReport>;

export const ObligationKind = z.enum([
  'positive',
  'negative',
  'boundary',
  'allow',
  'deny',
  'bulk',
  'ui',
  'nfr',
  'regression',
]);
export type ObligationKind = z.infer<typeof ObligationKind>;

/** Something the design MUST cover, derived by code from requirements + snapshot. */
export const CoverageObligation = z.object({
  id: z.string().regex(/^OB-\d{3,}$/),
  requirementId: z.string(),
  /** Section ref (AC2, BR-04, NFR-01) or `*` when the requirement cites none. */
  ref: z.string(),
  kind: ObligationKind,
  detail: z.string(),
  /** Boundary values / persona id / object, depending on kind. */
  values: z.array(z.string()).default([]),
  persona: z.string().optional(),
  /** Story AC (always mandatory) vs. other requirement item. */
  isAc: z.boolean().default(false),
  /** Evidence a step covering this obligation may cite (code-selected; contested sections excluded). */
  evidenceIds: z.array(z.string()).default([]),
  /**
   * Evidence every step of this obligation carries, whatever the model cites (code appends it): the org check a
   * negative is about, and whole-requirement org contests (component NOT_FOUND, no mechanism). Stops a draft from
   * citing only the favourable subset of the evidence.
   */
  mustCite: z.array(z.string()).default([]),
  /** Best level reachable with that evidence (assignLevel); UNKNOWN means the case will be REVIEW_REQUIRED. */
  level: EvidenceLevel,
  /** Why the level is not assertable, when it is not. */
  levelReason: z.string().optional(),
  /** Outcome text taken verbatim from evidence (used by the mechanical path and as a hint to the Planner). */
  expectedHint: z.string().optional(),
  /** Imported manual test that already covers this obligation (reuse candidate) or that must be re-run. */
  manualTestIds: z.array(z.string()).default([]),
  tier: RegressionTier.default('mandatory'),
});
export type CoverageObligation = z.infer<typeof CoverageObligation>;

export const FindingSeverity = z.enum(['H', 'M', 'L']);

export const ReviewRule = z.enum([
  'ac-positive',
  'ac-negative',
  'obligation-uncovered',
  'high-risk-uncovered',
  'persona-unused',
  'deny-missing',
  'boundary-values',
  'bulk-missing',
  'vague-expectation',
  'scope-creep',
  'duplicate',
  'ungrounded-expectation',
  'judge',
  // Test Reviewer pass 2 (generated code, Phase 4)
  'spec-missing',
  'step-missing',
  'assertion-missing',
  'assertion-unreferenced',
  'assertion-not-assertable',
  'ungrounded-value',
  'meta-incomplete',
  'raw-locator',
  'locator-not-active',
  'locator-unresolved',
  'data-binding',
  'persona-unavailable',
  'ast-violation',
  'typecheck',
  'lint',
  'not-listed',
  'mechanical',
  /** The case expects a specific error message but the org has no evidence for its text (operator 2026-11-26). */
  'message-unevidenced',
  /** The case quotes an error message that differs from the org rule's message the spec asserts. */
  'message-mismatch',
  /**
   * The message text is now evidenced by a UI observation (Explorer, OBSERVED) but the spec does not assert it — a
   * human accepts the observed text and the spec is regenerated to assert it (Phase 5).
   */
  'message-unasserted',
  /**
   * A generated test asserts on a URL or a record id (dynamic values). Operator rule 2026-11-26: after Save assert
   * toast → related list → header → SOQL by run tag instead. Blocking.
   */
  'dynamic-assertion',
  /** Operator rule 2026-11-26 (1): a value typed into a field must fit the field's length (org snapshot). */
  'field-length',
  /** Operator rule 2026-11-26 (2): record fields / related lists are read through the page object's tab helper. */
  'tab-unaware-read',
  /** Operator rule 2026-11-26 (3): a run-specific value (QA-run-…) written into a test instead of made at run time. */
  'build-time-value',
  /** Operator rule 2026-11-26 (3): two records the test creates share a unique value (one per record). */
  'shared-unique',
]);
export type ReviewRule = z.infer<typeof ReviewRule>;

/** Test Reviewer pass-1 finding. Nothing may stay OPEN when the design is reported. */
export const ReviewFinding = z.object({
  id: z.string().regex(/^RF-\d{3,}$/),
  /** Identifies "the same finding" across review rounds (rule + subject). */
  key: z.string().default(''),
  round: z.number().int().min(1),
  severity: FindingSeverity,
  rule: ReviewRule,
  caseIds: z.array(z.string()).default([]),
  requirementIds: z.array(z.string()).default([]),
  refs: z.array(z.string()).default([]),
  text: z.string(),
  origin: z.enum(['deterministic', 'judge']),
  status: z.enum(['OPEN', 'RESOLVED', 'JUSTIFIED']),
  /** How it was resolved (case changed) or why it is justified. */
  resolution: z.string().optional(),
  resolvedBy: z.enum(['planner', 'qa-lead', 'recheck', 'judge']).optional(),
  /** Settled by the QA Lead without a fix: the affected cases were set to REVIEW_REQUIRED for a human. */
  escalated: z.boolean().default(false),
  /** 1 (or absent) = test design (Phase 3), 2 = generated code (Phase 4). */
  pass: z.union([z.literal(1), z.literal(2)]).optional(),
  /** Pass 2: repo-relative spec paths the finding is about. */
  paths: z.array(z.string()).optional(),
});
export type ReviewFinding = z.infer<typeof ReviewFinding>;
