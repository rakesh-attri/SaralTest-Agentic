// Model output of the Failure Investigator (rule 2): the reasoning model may conclude only when no deterministic rule
// decided, only among hypotheses the experiments did not refute, and only citing evidence ids it was shown.
import { z } from 'zod';
import { Verdict } from '../../core/schemas/investigation.js';

export const InvestigatorConclusion = z.object({
  verdict: Verdict,
  confidence: z.number().min(0).max(1),
  rationale: z.string().min(10).max(800),
  evidenceIds: z.array(z.string()).min(1),
});
export type InvestigatorConclusion = z.infer<typeof InvestigatorConclusion>;

export const CONCLUSION_CONTRACT = `{"verdict": one of the allowed verdicts, "confidence": 0..1, "rationale": "≤ 800 chars, cites what the experiments showed", "evidenceIds": ["EV-…", …] (only ids listed in EVIDENCE)}`;
