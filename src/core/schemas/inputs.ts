import { z } from 'zod';
import { Priority } from './common.js';
import { SourceRef } from './requirement.js';

/**
 * Normalized input (PLAN.md §7a). Every adapter produces a SourceDocument deterministically (no LLM); the Spec Analyst
 * turns its sections into canonical Requirements and must cite section refs that exist here.
 */
export const SectionKind = z.enum([
  'summary',
  'description',
  'ac',
  'rule',
  'nfr',
  'assumption',
  'persona',
  'scope',
  'out-of-scope',
  'scenario',
  'test',
  'text',
]);
export type SectionKind = z.infer<typeof SectionKind>;

export const SourceSection = z.object({
  /** Stable reference inside the document: `AC2`, `BR-03`, `NFR-01`, `S3` (generic text block) … unique per document. */
  ref: z.string().min(1),
  kind: SectionKind,
  heading: z.string().optional(),
  text: z.string(),
});
export type SourceSection = z.infer<typeof SourceSection>;

export const SourceDocument = z.object({
  /** Short id used as a prefix when refs from several documents meet, e.g. `SF-12`, `BRD-CON-012`. */
  docId: z.string().min(1),
  source: SourceRef,
  title: z.string(),
  /** Free metadata (issue type, labels, components, status …). Never secrets. */
  meta: z.record(z.string(), z.unknown()).default({}),
  sections: z.array(SourceSection),
  /** Normalized full text (what the hash covers). */
  text: z.string(),
  /** Parser warnings (e.g. a table the PDF parser could not keep together). */
  warnings: z.array(z.string()).default([]),
});
export type SourceDocument = z.infer<typeof SourceDocument>;

export const LastRunStatus = z.enum(['PASS', 'FAIL', 'BLOCKED', 'NOT_RUN', 'UNKNOWN']);

/** An existing (manual) test case imported from xlsx/csv — reused by the Planner, analysed for gaps (PLAN.md §7a). */
export const ManualTestCase = z.object({
  id: z.string().min(1),
  title: z.string(),
  /** Requirement refs as written in the sheet (AC1, BR-05 …). Empty = no requirement behind the test. */
  requirementRefs: z.array(z.string()),
  persona: z.string().optional(),
  preconditions: z.array(z.string()),
  steps: z.array(z.string()),
  expected: z.string().optional(),
  priority: Priority.optional(),
  type: z.string().optional(),
  lastRun: z.object({ status: LastRunStatus, date: z.string().optional() }),
  source: SourceRef,
  /** Original row number (1-based, header = 1) for traceability. */
  row: z.number().int().positive().optional(),
});
export type ManualTestCase = z.infer<typeof ManualTestCase>;

/** Past defect (JIRA bug or past results.json failure) — RAG + Risk Analyzer input. */
export const DefectRecord = z.object({
  key: z.string(),
  summary: z.string(),
  status: z.string().optional(),
  priority: z.string().optional(),
  components: z.array(z.string()).default([]),
  labels: z.array(z.string()).default([]),
  created: z.string().optional(),
  resolved: z.string().optional(),
  description: z.string().optional(),
  source: SourceRef,
});
export type DefectRecord = z.infer<typeof DefectRecord>;

/** A Salesforce metadata component changed in a git diff (impact + regression selection input). */
export const ChangedComponent = z.object({
  type: z.string(),
  apiName: z.string(),
  path: z.string(),
  change: z.enum(['ADDED', 'MODIFIED', 'DELETED', 'RENAMED']),
});
export type ChangedComponent = z.infer<typeof ChangedComponent>;

/** Exploratory objective typed in chat — stored for the Autonomous Explorer (Phase 7). */
export const ExploratoryObjective = z.object({
  id: z.string(),
  text: z.string().min(1),
  timeBoxMinutes: z.number().positive().optional(),
  source: SourceRef,
});
export type ExploratoryObjective = z.infer<typeof ExploratoryObjective>;
