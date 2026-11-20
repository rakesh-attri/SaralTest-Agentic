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
    steps: z.array(z.object({ action: z.string(), expected: ExpectedResult })).min(1),
    tags: z.array(z.string()),
    reviewStatus: z.enum(['APPROVED', 'REVIEW_REQUIRED', 'BLOCKED']),
    snapshotId: z.string(),
  })
  .superRefine((tc, ctx) => {
    // An UNKNOWN_OR_CONTRADICTORY expectation forces REVIEW_REQUIRED (or BLOCKED); it can never be APPROVED.
    if (
      tc.reviewStatus === 'APPROVED' &&
      tc.steps.some((s) => s.expected.evidenceLevel === 'UNKNOWN_OR_CONTRADICTORY')
    ) {
      ctx.addIssue({
        code: 'custom',
        path: ['reviewStatus'],
        message: 'APPROVED case has an UNKNOWN_OR_CONTRADICTORY expectation',
      });
    }
  });
export type TestCase = z.infer<typeof TestCase>;

export const RtmRow = z.object({ requirementId: z.string(), testCaseIds: z.array(z.string()) });
export type RtmRow = z.infer<typeof RtmRow>;
