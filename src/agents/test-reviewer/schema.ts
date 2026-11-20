import { z } from 'zod';

/** Judge (adversarial reviewer) output. Ids must exist; code assigns finding ids, rounds and status. */
export const JudgeFindingDraft = z.object({
  severity: z.enum(['H', 'M', 'L']),
  caseIds: z.array(z.string()).default([]),
  requirementIds: z.array(z.string()).default([]),
  /** Checklist item: coverage, negative, persona, boundary, bulk, observability, scope, duplicate, evidence … */
  topic: z.string().min(3),
  text: z.string().min(15),
});
export type JudgeFindingDraft = z.infer<typeof JudgeFindingDraft>;

export const JudgeOutput = z.object({ findings: z.array(JudgeFindingDraft).max(12) });
export type JudgeOutput = z.infer<typeof JudgeOutput>;

/** Later rounds: the judge only verifies whether its open findings are resolved by the revised cases. */
export const JudgeVerifyOutput = z.object({
  verdicts: z.array(z.object({ findingId: z.string(), resolved: z.boolean(), reason: z.string().min(5) })),
});
export type JudgeVerifyOutput = z.infer<typeof JudgeVerifyOutput>;
