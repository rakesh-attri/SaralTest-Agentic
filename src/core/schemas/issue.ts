import { z } from 'zod';
import { IsoDate } from './common.js';

export const ISSUE_KINDS = [
  'TRANSIENT',
  'TOOL_UNAVAILABLE',
  'AUTH',
  'AMBIGUOUS_SPEC',
  'INVALID_LLM_OUTPUT',
  'LOCATOR',
  'PRODUCT_DEFECT',
  'DATA',
  'ENVIRONMENT',
  'BUDGET',
  'HARD_STOP',
  'UNKNOWN',
] as const;
export const IssueKind = z.enum(ISSUE_KINDS);
export type IssueKind = z.infer<typeof IssueKind>;

export const IssueResolution = z.enum(['RETRIED', 'FELL_BACK', 'DEGRADED', 'ASKED', 'ESCALATED', 'IGNORED']);
export type IssueResolution = z.infer<typeof IssueResolution>;

export const Issue = z.object({
  id: z.string().min(1),
  kind: IssueKind,
  node: z.string().min(1),
  message: z.string(),
  detail: z.unknown().optional(),
  attempts: z.number().int().nonnegative(),
  resolution: IssueResolution.optional(),
  createdAt: IsoDate,
});
export type Issue = z.infer<typeof Issue>;
