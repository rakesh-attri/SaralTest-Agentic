import { z } from 'zod';
import {
  Clarification,
  CreatedRecord,
  DefectDraft,
  EvalScore,
  EvidenceEntry,
  Investigation,
  Issue,
  LearningCandidate,
  Requirement,
  RtmRow,
  TestCase,
  TestResult,
} from './schemas/index.js';

/**
 * Run state shared by every node (PLAN.md §4). Phase 0 defines the contract; the LangGraph `Annotation.Root`
 * wrapper (reducers, checkpointing) is added with the main graph in Phase 1.
 *
 * Sub-structures owned by later phases (story, charter, orgContext, impact, generated, dataPlan) are typed as
 * open objects with the fields known today and are tightened in the phase that produces them.
 */
export const SpecSource = z.object({
  type: z.enum(['jira', 'ado', 'chat', 'file']),
  ref: z.string(),
});
export type SpecSource = z.infer<typeof SpecSource>;

export const StorySnapshot = z.looseObject({
  key: z.string(),
  summary: z.string(),
  description: z.string().optional(),
  acceptanceCriteria: z.array(z.string()),
  links: z.array(z.string()).default([]),
});
export const TestCharter = z.looseObject({
  mission: z.string(),
  risks: z.array(z.string()),
  personas: z.array(z.string()),
  scope: z.array(z.string()),
  exitCriteria: z.array(z.string()),
});
export const OrgContext = z.looseObject({ snapshotId: z.string(), components: z.array(z.string()) });
export const ImpactReport = z.looseObject({
  dependencies: z.array(z.string()),
  regressionCandidates: z.array(z.string()),
  riskScores: z.record(z.string(), z.number()),
});
export const GeneratedArtifact = z.object({
  kind: z.enum(['spec', 'page-object', 'api-test', 'fixture']),
  path: z.string(),
  hash: z.string(),
  testCaseIds: z.array(z.string()),
});
export const DataPlan = z.looseObject({ recipe: z.string(), steps: z.array(z.unknown()) });

export const RunStatus = z.enum(['RUNNING', 'COMPLETE', 'PARTIAL', 'BLOCKED']);
export type RunStatus = z.infer<typeof RunStatus>;

export const Autonomy = z.enum(['L1', 'L2', 'L3']);
export type Autonomy = z.infer<typeof Autonomy>;

export const Budget = z.object({
  tokensUsed: z.number().int().nonnegative(),
  tokenLimit: z.number().int().positive(),
  startedAt: z.string(),
  timeLimitMin: z.number().positive(),
});
export type Budget = z.infer<typeof Budget>;

export const QARunState = z.object({
  runId: z.string(),
  storyKey: z.string().optional(),
  org: z.string(),
  autonomy: Autonomy,
  source: SpecSource,
  story: StorySnapshot.optional(),
  requirements: z.array(Requirement),
  clarifications: z.array(Clarification),
  charter: TestCharter.optional(),
  orgContext: OrgContext.optional(),
  impact: ImpactReport.optional(),
  testCases: z.array(TestCase),
  rtm: z.array(RtmRow),
  generated: z.array(GeneratedArtifact),
  dataPlan: DataPlan.optional(),
  dataLedger: z.array(CreatedRecord),
  results: z.array(TestResult),
  investigations: z.array(Investigation),
  defects: z.array(DefectDraft),
  evidence: z.array(EvidenceEntry),
  evalScores: z.array(EvalScore),
  learnings: z.array(LearningCandidate),
  issues: z.array(Issue),
  status: RunStatus,
  budget: Budget,
});
export type QARunState = z.infer<typeof QARunState>;

/** Fresh state for a new run. */
export function initialRunState(input: {
  runId: string;
  org: string;
  autonomy: Autonomy;
  source: SpecSource;
  storyKey?: string;
  tokenLimit: number;
  timeLimitMin: number;
  now?: Date;
}): QARunState {
  return {
    runId: input.runId,
    ...(input.storyKey !== undefined ? { storyKey: input.storyKey } : {}),
    org: input.org,
    autonomy: input.autonomy,
    source: input.source,
    requirements: [],
    clarifications: [],
    testCases: [],
    rtm: [],
    generated: [],
    dataLedger: [],
    results: [],
    investigations: [],
    defects: [],
    evidence: [],
    evalScores: [],
    learnings: [],
    issues: [],
    status: 'RUNNING',
    budget: {
      tokensUsed: 0,
      tokenLimit: input.tokenLimit,
      startedAt: (input.now ?? new Date()).toISOString(),
      timeLimitMin: input.timeLimitMin,
    },
  };
}
