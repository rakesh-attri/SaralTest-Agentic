import { z } from 'zod';
import { Environment, IsoDate } from './common.js';

export const ResultState = z.enum(['PASS', 'FAIL', 'BLOCKED', 'SKIPPED', 'UNCERTAIN']);
export type ResultState = z.infer<typeof ResultState>;

export const TestResult = z.object({
  testId: z.string(),
  state: ResultState,
  reason: z.string().optional(),
  evidenceIds: z.array(z.string()),
  /** environment !== 'LIVE' must be labelled as such in every report. */
  environment: Environment,
  snapshotId: z.string(),
  runId: z.string(),
});
export type TestResult = z.infer<typeof TestResult>;

export const EvidenceEntry = z.object({
  id: z.string(),
  claim: z.string(),
  sources: z.array(z.string()).min(1),
  agent: z.string(),
  confidence: z.number().min(0).max(1),
  environment: Environment,
  createdAt: IsoDate,
});
export type EvidenceEntry = z.infer<typeof EvidenceEntry>;

export const EvalScore = z.object({
  metric: z.string(),
  score: z.number().nullable(),
  threshold: z.number().optional(),
  status: z.enum(['PASS', 'FAIL', 'UNEVALUATED']),
  detail: z.string().optional(),
});
export type EvalScore = z.infer<typeof EvalScore>;
