// Model outputs of the Defect Judge (rule 2). The drafting model only proposes a title; the judge model (≠ coder,
// rule 8) checks every claim of the rendered bug text against the evidence it is shown.
import { z } from 'zod';

export const TitleDraft = z.object({
  /** `[Object] <what> when <condition> for <persona>` (defect-investigation SKILL). */
  title: z.string().min(15).max(160),
});
export type TitleDraft = z.infer<typeof TitleDraft>;
export const TITLE_FORMAT = /^\[[A-Za-z_]+\] .+ when .+ for [\w-]+$/;

export const JudgeVerdict = z.object({
  decision: z.enum(['CONFIRMED', 'SUSPECTED', 'REJECTED']),
  /** Claims of the bug text that no EVIDENCE line supports (quote them). Empty when every claim is supported. */
  unsupportedClaims: z.array(z.string()).default([]),
  reason: z.string().min(10).max(800),
});
export type JudgeVerdict = z.infer<typeof JudgeVerdict>;

export const JUDGE_CONTRACT = `{"decision": "CONFIRMED" | "SUSPECTED" | "REJECTED", "unsupportedClaims": ["quoted claim", …], "reason": "≤ 800 chars"}`;
export const TITLE_CONTRACT = `{"title": "[Object] <what> when <condition> for <persona>"}`;
