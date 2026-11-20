import { z } from 'zod';
import { IsoDate } from './common.js';

export const DataWriteState = z.enum(['PLANNED', 'SENT', 'CONFIRMED', 'UNCERTAIN', 'CLEANED']);
export type DataWriteState = z.infer<typeof DataWriteState>;

export const DataWrite = z.object({
  idempotencyKey: z.string().min(8),
  runId: z.string(),
  object: z.string(),
  plannedFields: z.record(z.string(), z.unknown()),
  recordId: z.string().optional(),
  state: DataWriteState,
});
export type DataWrite = z.infer<typeof DataWrite>;

/** Ledger entry for a record this run created. */
export const CreatedRecord = z.object({
  idempotencyKey: z.string(),
  object: z.string(),
  recordId: z.string(),
  createdAt: IsoDate,
  order: z.number().int().nonnegative(),
});
export type CreatedRecord = z.infer<typeof CreatedRecord>;

export const AuditEntry = z.object({
  at: IsoDate,
  runId: z.string(),
  orgId: z.string(),
  user: z.string(),
  persona: z.string(),
  action: z.enum(['observe', 'mutate']),
  tool: z.string(),
  object: z.string().optional(),
  recordId: z.string().optional(),
  before: z.unknown().optional(),
  after: z.unknown().optional(),
  approvalId: z.string().optional(),
  outcome: z.enum(['ALLOWED', 'REFUSED', 'SUCCEEDED', 'FAILED']).optional(),
});
export type AuditEntry = z.infer<typeof AuditEntry>;
