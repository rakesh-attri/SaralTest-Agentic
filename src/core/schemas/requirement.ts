import { z } from 'zod';
import { Risk } from './common.js';

export const SourceRef = z.object({
  type: z.enum(['jira', 'ado', 'chat', 'file', 'manual-test', 'defect', 'git-diff']),
  ref: z.string(),
  version: z.string().optional(),
  hash: z.string(),
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

export const Clarification = z.object({
  id: z.string(),
  requirementId: z.string().optional(),
  question: z.string(),
  answer: z.string().optional(),
  assumption: z.string().optional(),
  status: z.enum(['OPEN', 'ANSWERED', 'ASSUMED', 'WITHDRAWN']),
});
export type Clarification = z.infer<typeof Clarification>;
