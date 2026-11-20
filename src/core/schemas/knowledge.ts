import { z } from 'zod';
import { IsoDate } from './common.js';

export const ComponentVersion = z.object({
  snapshotId: z.string(),
  type: z.string(),
  apiName: z.string(),
  version: z.string().optional(),
  hash: z.string(),
  dataScope: z.string(),
  /** Inaccessible components are UNKNOWN, never "missing" (PLAN.md §7c). */
  evidenceStatus: z.enum(['DECLARED', 'OBSERVED', 'VERIFIED', 'UNKNOWN']),
  reviewStatus: z.enum(['APPROVED', 'REVIEW_REQUIRED', 'RE_VERIFY']),
});
export type ComponentVersion = z.infer<typeof ComponentVersion>;

export const Snapshot = z.object({
  id: z.string(),
  orgId: z.string(),
  capturedAt: IsoDate,
  sourceType: z.enum(['METADATA', 'UI_OBSERVATION', 'API_RESULT']),
  release: z.string(),
  persona: z.string().optional(),
  components: z.array(ComponentVersion),
});
export type Snapshot = z.infer<typeof Snapshot>;
