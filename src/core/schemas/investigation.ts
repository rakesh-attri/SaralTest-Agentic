import { z } from 'zod';

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

export const Investigation = z.object({
  failureId: z.string(),
  observations: z.array(z.string()),
  hypotheses: z.array(
    z.object({
      id: z.string(),
      text: z.string(),
      test: z.string(),
      result: z.string().optional(),
      evidenceIds: z.array(z.string()),
    }),
  ),
  verdict: Verdict,
  confidence: z.number().min(0).max(1),
  status: z.enum(['SUSPECTED', 'CONFIRMED']),
});
export type Investigation = z.infer<typeof Investigation>;

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
});
export type DefectDraft = z.infer<typeof DefectDraft>;
