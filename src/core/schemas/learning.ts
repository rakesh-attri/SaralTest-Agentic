import { z } from 'zod';

export const LearningCandidate = z.object({
  id: z.string(),
  type: z.enum(['locator', 'org-quirk', 'defect-pattern', 'data-rule', 'design-heuristic', 'workflow-change', 'flaky']),
  text: z.string(),
  evidenceIds: z.array(z.string()).min(1),
  org: z.string(),
  release: z.string(),
  snapshotId: z.string(),
  confidence: z.number().min(0).max(1),
  /** Hypotheses are never promoted automatically (CLAUDE.md rule 12). */
  status: z.enum(['HYPOTHESIS', 'VERIFIED', 'RETIRED']),
});
export type LearningCandidate = z.infer<typeof LearningCandidate>;
