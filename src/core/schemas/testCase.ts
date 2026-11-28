import { z } from 'zod';
import { Priority, Severity } from './common.js';

/** PLAN.md §7f — only the first three levels may become assertions. */
export const EvidenceLevel = z.enum([
  'APPROVED_REQUIREMENT',
  'DECLARED_CONFIG',
  'VERIFIED',
  'OBSERVED_ONLY',
  'UNKNOWN_OR_CONTRADICTORY',
]);
export type EvidenceLevel = z.infer<typeof EvidenceLevel>;
export const ASSERTABLE_LEVELS: readonly EvidenceLevel[] = ['APPROVED_REQUIREMENT', 'DECLARED_CONFIG', 'VERIFIED'];

export const ReviewStatus = z.enum(['APPROVED', 'REVIEW_REQUIRED', 'BLOCKED']);
export type ReviewStatus = z.infer<typeof ReviewStatus>;
export const isAssertable = (level: EvidenceLevel): boolean => ASSERTABLE_LEVELS.includes(level);

export const ExpectedResult = z.object({
  text: z.string(),
  evidenceLevel: EvidenceLevel,
  evidenceIds: z.array(z.string()),
});
export type ExpectedResult = z.infer<typeof ExpectedResult>;

export const TestType = z.enum([
  'functional',
  'e2e',
  'api',
  'integration',
  'security',
  'negative',
  'automation',
  'bulk',
  'data',
  'visual',
  'ui',
  'a11y',
  'perf',
  'exploratory',
]);
export type TestType = z.infer<typeof TestType>;

/** Regression selection tier (test-design skill): low risk never removes AC coverage. */
export const RegressionTier = z.enum(['mandatory', 'recommended', 'optional']);
export type RegressionTier = z.infer<typeof RegressionTier>;

/** Where a case came from: Planner draft, imported manual test, mechanical, operator-authored (Phase 7 case edits) or an Explorer finding promoted after review (Phase 7). */
export const CaseOrigin = z.enum(['planned', 'manual-reuse', 'mechanical', 'operator', 'exploratory']);
export type CaseOrigin = z.infer<typeof CaseOrigin>;

export const TestStep = z.object({ action: z.string().min(1), expected: ExpectedResult });
export type TestStep = z.infer<typeof TestStep>;

export const TestCase = z
  .object({
    id: z.string(),
    title: z.string(),
    requirementIds: z.array(z.string()).min(1),
    riskIds: z.array(z.string()),
    technique: z.string(),
    persona: z.string(),
    recordType: z.string().optional(),
    type: TestType,
    priority: Priority,
    severity: Severity,
    preconditions: z.array(z.string()),
    dataRecipe: z.string().optional(),
    steps: z.array(TestStep).min(1),
    tags: z.array(z.string()),
    reviewStatus: ReviewStatus,
    snapshotId: z.string(),
    /** Why the case is not APPROVED (code-decided: evidence level, missing persona, open finding …). */
    reviewReasons: z.array(z.string()).default([]),
    origin: CaseOrigin.default('planned'),
    /** Imported manual test this case reuses (origin = manual-reuse). */
    manualTestId: z.string().optional(),
    /** Section refs the case covers (e.g. AC2, BR-04). */
    refs: z.array(z.string()).default([]),
    /** Coverage obligations (deterministic) this case satisfies. */
    obligationIds: z.array(z.string()).default([]),
    regressionTier: RegressionTier.default('optional'),
    /** `manual`: the operator ruled the case not automatable — no spec is generated; the RTM lists it as manual. */
    execution: z.enum(['automated', 'manual']).optional(),
    executionReason: z.string().optional(),
  })
  .superRefine((tc, ctx) => {
    // Only assertable expectations (PLAN.md §7f) may sit in an APPROVED case.
    if (tc.reviewStatus === 'APPROVED') {
      tc.steps.forEach((s, i) => {
        if (!isAssertable(s.expected.evidenceLevel)) {
          ctx.addIssue({
            code: 'custom',
            path: ['steps', i, 'expected', 'evidenceLevel'],
            message: `APPROVED case has a ${s.expected.evidenceLevel} expectation`,
          });
        }
      });
    }
    // Every expectation cites evidence unless it is explicitly UNKNOWN_OR_CONTRADICTORY.
    tc.steps.forEach((s, i) => {
      if (s.expected.evidenceLevel !== 'UNKNOWN_OR_CONTRADICTORY' && s.expected.evidenceIds.length === 0) {
        ctx.addIssue({
          code: 'custom',
          path: ['steps', i, 'expected', 'evidenceIds'],
          message: `${s.expected.evidenceLevel} expectation without an evidence id`,
        });
      }
    });
  });
export type TestCase = z.infer<typeof TestCase>;

/** A case the build generates a spec for: APPROVED and not ruled manual-only. */
export const isAutomatable = (c: Pick<TestCase, 'reviewStatus' | 'execution'>): boolean =>
  c.reviewStatus === 'APPROVED' && c.execution !== 'manual';

export const RtmStatus = z.enum(['designed', 'gap', 'review-required', 'blocked', 'excluded']);
export type RtmStatus = z.infer<typeof RtmStatus>;

/** RTM row (test-design skill §RTM). Coverage gate: 100% of ACs. */
export const RtmRow = z.object({
  requirementId: z.string(),
  testCaseIds: z.array(z.string()),
  refs: z.array(z.string()).default([]),
  riskIds: z.array(z.string()).default([]),
  types: z.array(TestType).default([]),
  manualTestIds: z.array(z.string()).default([]),
  status: RtmStatus.default('designed'),
  /** Covered obligations / all obligations of this requirement. */
  coverage: z.object({ covered: z.number().int().nonnegative(), total: z.number().int().nonnegative() }).optional(),
  note: z.string().optional(),
});
export type RtmRow = z.infer<typeof RtmRow>;
