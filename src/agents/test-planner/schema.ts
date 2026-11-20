import { z } from 'zod';
import { TestType } from '../../core/schemas/index.js';

/**
 * What the model may draft. Evidence levels, review status, priority, ids, tiers and RTM rows are NOT here: code
 * computes them (oracles, risk model). Every step is one verification point that covers one obligation and cites
 * evidence from that obligation's allowed list.
 */
export const StepDraft = z.object({
  /** What the tester does, including navigation and test data (e.g. "Open the Account, … click Save"). */
  action: z.string().min(3),
  /** The observable outcome to check. Values (messages, numbers) only as stated in the cited evidence. */
  expected: z.string().min(3),
  obligationId: z.string(),
  /** Evidence ids from the obligation's allowed list. */
  evidence: z.array(z.string()).min(1),
});
export type StepDraft = z.infer<typeof StepDraft>;

export const CaseDraft = z.object({
  /** Existing case id when revising; any unique short key for new cases. */
  key: z.string().min(1),
  title: z.string().min(5),
  obligationIds: z.array(z.string()).min(1),
  persona: z.string(),
  type: TestType,
  technique: z.string().min(3),
  preconditions: z.array(z.string()).default([]),
  /** Data recipe name when one exists (examples/recipes), never invented field values. */
  dataRecipe: z.string().optional(),
  /** Imported manual test this case reuses (must be listed on one of its obligations). */
  manualTestId: z.string().optional(),
  steps: z.array(StepDraft).min(1),
});
export type CaseDraft = z.infer<typeof CaseDraft>;

export const PlanOutput = z.object({ cases: z.array(CaseDraft).min(1) });
export type PlanOutput = z.infer<typeof PlanOutput>;

export const ReviseOutput = z.object({
  /** Changed or new cases (same `key` = replace that case). */
  cases: z.array(CaseDraft).default([]),
  /** Cases to drop (duplicates, scope creep). */
  remove: z.array(z.string()).default([]),
  /** Findings answered with a reason instead of a change. */
  justifications: z.array(z.object({ findingId: z.string(), reason: z.string().min(10) })).default([]),
});
export type ReviseOutput = z.infer<typeof ReviseOutput>;
