import { z } from 'zod';
import { Risk } from './common.js';

export const SourceRef = z.object({
  type: z.enum(['jira', 'ado', 'chat', 'file', 'manual-test', 'defect', 'git-diff']),
  ref: z.string(),
  version: z.string().optional(),
  hash: z.string(),
  /** Section inside the source, e.g. `AC2`, `BR-03`, `NFR-01`, `MTC-004` (must exist in the parsed source). */
  section: z.string().optional(),
});
export type SourceRef = z.infer<typeof SourceRef>;

/** Canonical requirement — every input adapter produces this (PLAN.md §4). */
export const Requirement = z.object({
  id: z.string().regex(/^[A-Za-z0-9_-]+-R\d{2,}$/, 'stable id like SF-1234-R03'),
  businessObjective: z.string(),
  actors: z.array(z.string()),
  personas: z.array(z.string()),
  preconditions: z.array(z.string()),
  actions: z.array(z.string()),
  businessRules: z.array(z.string()),
  expectedOutcomes: z.array(z.string()),
  dependencies: z.array(z.string()),
  dataRequirements: z.array(z.string()),
  risk: Risk,
  assumptions: z.object({ known: z.array(z.string()), unknown: z.array(z.string()) }),
  sources: z.array(SourceRef).min(1),
  type: z.enum(['functional', 'validation', 'security', 'data', 'ui', 'integration', 'non-functional']),
  /** No clear expected outcome → REVIEW_REQUIRED. */
  status: z.enum(['EXECUTABLE', 'REVIEW_REQUIRED']),
});
export type Requirement = z.infer<typeof Requirement>;

export const ClarificationStatus = z.enum(['OPEN', 'ANSWERED', 'ASSUMED', 'WITHDRAWN']);
export type ClarificationStatus = z.infer<typeof ClarificationStatus>;

/**
 * A question to the human (requirement-analysis skill: AC/BR reference, the concrete ambiguity, what is known today,
 * test impact). Unanswered questions become ASSUMED with `proposedAssumption` — always flagged, never silent.
 */
export const Clarification = z.object({
  id: z.string(),
  requirementId: z.string().optional(),
  /** All requirements whose tests depend on the answer. */
  requirementIds: z.array(z.string()).default([]),
  /** Source section refs the question is about (AC3, BR-04 …). */
  refs: z.array(z.string()).default([]),
  question: z.string(),
  testImpact: z.string().optional(),
  /** Safest, most common interpretation — used when no answer arrives in time (skill step 7). */
  proposedAssumption: z.string().optional(),
  /** 1 = most important. */
  priority: z.number().int().positive().optional(),
  round: z.number().int().positive().default(1),
  answer: z.string().optional(),
  assumption: z.string().optional(),
  status: ClarificationStatus,
});
export type Clarification = z.infer<typeof Clarification>;

/** What the Spec Analyst (deterministic lint + LLM) found while reading the sources. */
export const FindingKind = z.enum([
  'CONFLICT',
  'AMBIGUITY',
  'MISSING_DETAIL',
  'COVERAGE_GAP',
  'UNSUPPORTED_TEST',
  'DUPLICATE_TEST',
  'RISK_SIGNAL',
  'ORG_CHECK_NEEDED',
]);
export type FindingKind = z.infer<typeof FindingKind>;

export const AnalysisFinding = z.object({
  id: z.string(),
  kind: FindingKind,
  text: z.string().min(1),
  /** Section refs (AC4, BR-10, MTC-008 …) — at least one: a finding without a source is not reported. */
  refs: z.array(z.string()).min(1),
  requirementIds: z.array(z.string()).default([]),
  severity: z.enum(['HIGH', 'MEDIUM', 'LOW']),
  /** `lint` = deterministic rule, `llm` = Spec Analyst model output (validated). */
  origin: z.enum(['lint', 'llm']),
  rule: z.string().optional(),
});
export type AnalysisFinding = z.infer<typeof AnalysisFinding>;
