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
  label: z.string().optional(),
  /** Owning object for object-scoped components. */
  parent: z.string().optional(),
  /** Canonical content the hash is computed from (metadata only; never record data or secrets). */
  body: z.record(z.string(), z.unknown()).optional(),
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

/** Snapshot header without components (what lists and reports show). */
export const SnapshotInfo = z.object({
  id: z.string(),
  orgId: z.string(),
  orgAlias: z.string(),
  capturedAt: IsoDate,
  sourceType: z.enum(['METADATA', 'UI_OBSERVATION', 'API_RESULT']),
  release: z.string(),
  persona: z.string().optional(),
  environment: z.enum(['LIVE', 'FIXTURE']),
  apiVersion: z.string(),
  objects: z.array(z.string()),
  componentCount: z.number().int(),
  unknownCount: z.number().int(),
  runId: z.string().optional(),
});
export type SnapshotInfo = z.infer<typeof SnapshotInfo>;

export const DiffChange = z.enum(['added', 'removed', 'changed', 'unknown']);
export const DiffEntry = z.object({
  type: z.string(),
  apiName: z.string(),
  parent: z.string().optional(),
  change: DiffChange,
  beforeHash: z.string().optional(),
  afterHash: z.string().optional(),
  /** Top-level body keys whose value changed (e.g. errorConditionFormula, errorMessage). */
  changedKeys: z.array(z.string()).optional(),
  /** Why an entry is `unknown` (area not readable in one of the snapshots). */
  reason: z.string().optional(),
});
export type DiffEntry = z.infer<typeof DiffEntry>;

export const SnapshotDiff = z.object({
  fromSnapshotId: z.string(),
  toSnapshotId: z.string(),
  orgId: z.string(),
  comparedObjects: z.array(z.string()),
  entries: z.array(DiffEntry),
  counts: z.object({ added: z.number(), removed: z.number(), changed: z.number(), unknown: z.number() }),
});
export type SnapshotDiff = z.infer<typeof SnapshotDiff>;

/** TestResult → TestCase → (spec hash, snapshotId, browser observation ids) (PLAN.md §7c). */
export const LineageEntry = z.object({
  assetType: z.string(),
  assetId: z.string(),
  snapshotId: z.string(),
  specHash: z.string().optional(),
  observationIds: z.array(z.string()).default([]),
  recordedAt: IsoDate,
});
export type LineageEntry = z.infer<typeof LineageEntry>;

/** A locator / learning / requirement / test asset that must be re-verified because a component it depends on changed. */
export const ReverifyMark = z.object({
  assetType: z.enum(['locator', 'learning', 'requirement', 'assumption', 'manual-test', 'test-case']),
  assetId: z.string(),
  componentType: z.string(),
  componentName: z.string(),
  change: DiffChange,
  /** Edge path from the asset to the changed component (citable evidence, PLAN.md §7). */
  path: z.array(z.string()),
  snapshotId: z.string(),
  createdAt: IsoDate,
  status: z.enum(['OPEN', 'CLEARED']).default('OPEN'),
});
export type ReverifyMark = z.infer<typeof ReverifyMark>;
