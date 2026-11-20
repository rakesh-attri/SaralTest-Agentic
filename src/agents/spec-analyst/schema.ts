import { z } from 'zod';
import { Risk } from '../../core/schemas/common.js';
import { FindingKind } from '../../core/schemas/requirement.js';

/**
 * Model-facing output schemas of the Spec Analyst (CLAUDE.md rule 2). The model never assigns requirement ids,
 * hashes or source versions: it cites section refs (`DOC#SECTION`) and code fills in the rest after checking that
 * every cited ref exists (rule 12).
 */
const str = z.string().trim();
const list = z.array(str).default([]);

export const SectionCite = str
  .min(3)
  .describe('qualified section ref exactly as shown in the sources, e.g. "SF-12#AC2"');

export const RequirementDraft = z.object({
  key: str.min(1).describe('temporary key unique within this reply, e.g. "r1"'),
  title: str.min(3).max(120),
  businessObjective: str.min(5).describe('one testable behaviour, in the words of the sources'),
  type: z.enum(['functional', 'validation', 'security', 'data', 'ui', 'integration', 'non-functional']),
  actors: list,
  personas: list.describe('only personas named in the sources'),
  preconditions: list,
  actions: list,
  businessRules: list,
  expectedOutcomes: list.describe('only outcomes the sources state; empty when the sources do not say'),
  /** False when the outcome is vague, unstated or depends on something not provided → REVIEW_REQUIRED. */
  expectedOutcomeClear: z.boolean(),
  reviewReason: str
    .optional()
    .describe('why the expected outcome is not clear (required when expectedOutcomeClear is false)'),
  dependencies: list,
  dataRequirements: list,
  risk: Risk,
  assumptionsKnown: list,
  assumptionsUnknown: list,
  sources: z.array(SectionCite).min(1),
});
export type RequirementDraft = z.infer<typeof RequirementDraft>;

export const ExtractOutput = z.object({
  requirements: z.array(RequirementDraft).min(1),
  /** Identified sections deliberately not turned into requirements (out of scope, duplicate wording …). */
  excluded: z.array(z.object({ ref: SectionCite, reason: str.min(5) })).default([]),
});
export type ExtractOutput = z.infer<typeof ExtractOutput>;

export const FindingDraft = z.object({
  kind: FindingKind,
  text: str.min(10),
  refs: z.array(SectionCite).min(1),
  requirementIds: list.describe('ids of affected requirements, e.g. "SF-12-R03"'),
  severity: Risk,
});
export type FindingDraft = z.infer<typeof FindingDraft>;

export const QuestionDraft = z.object({
  question: str.min(10),
  refs: z.array(SectionCite).min(1),
  requirementIds: list,
  testImpact: str.min(5),
  proposedAssumption: str.min(5).describe('safest, most common interpretation if nobody answers'),
  priority: z.number().int().min(1).max(99).describe('1 = most important'),
});
export type QuestionDraft = z.infer<typeof QuestionDraft>;

export const AnalyzeOutput = z.object({
  findings: z.array(FindingDraft).default([]),
  questions: z.array(QuestionDraft).default([]),
});
export type AnalyzeOutput = z.infer<typeof AnalyzeOutput>;

/** Requirement ↔ existing test coverage (deterministic, from refs). */
export const CoverageRow = z.object({
  requirementId: z.string(),
  sections: z.array(z.string()),
  coveredBy: z.array(z.string()),
});
export type CoverageRow = z.infer<typeof CoverageRow>;
