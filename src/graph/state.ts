import { Annotation } from '@langchain/langgraph';
import type { PolicyResponse } from '../config/schemas.js';
import type { Issue } from '../core/schemas/index.js';
import type { QARunState } from '../core/state.js';
import type { CoverageRow } from '../agents/spec-analyst/schema.js';
import type { TriageDecision } from '../agents/qa-lead/triage.js';

/**
 * LangGraph channels for QARunState (PLAN.md §4) plus graph-control fields. Reducers:
 * - `issues`: merge by id (a node appends new issues; triage updates their `resolution`)
 * - `evidence`, `triage`, `notes`: append
 * - everything else: last value wins (nodes return complete replacements)
 */
const last = <T>(init: () => T) => Annotation<T>({ reducer: (_a: T, b: T) => b, default: init });
const append = <T>() => Annotation<T[]>({ reducer: (a: T[], b: T[]) => [...a, ...b], default: () => [] });

export function mergeIssues(a: Issue[], b: Issue[]): Issue[] {
  const out = [...a];
  for (const issue of b) {
    const i = out.findIndex((x) => x.id === issue.id);
    if (i >= 0) out[i] = issue;
    else out.push(issue);
  }
  return out;
}

type S = QARunState;

export const QAGraphState = Annotation.Root({
  runId: last<S['runId']>(() => ''),
  storyKey: last<S['storyKey']>(() => undefined),
  org: last<S['org']>(() => ''),
  autonomy: last<S['autonomy']>(() => 'L2'),
  source: last<S['source']>(() => ({ type: 'chat', ref: '' })),
  story: last<S['story']>(() => undefined),
  inputs: last<S['inputs']>(() => []),
  sources: last<S['sources']>(() => []),
  existingTests: last<S['existingTests']>(() => []),
  defectHistory: last<S['defectHistory']>(() => []),
  changedComponents: last<S['changedComponents']>(() => []),
  objectives: last<S['objectives']>(() => []),
  requirements: last<S['requirements']>(() => []),
  findings: last<S['findings']>(() => []),
  clarifications: last<S['clarifications']>(() => []),
  clarifyRound: last<S['clarifyRound']>(() => 0),
  charter: last<S['charter']>(() => undefined),
  orgContext: last<S['orgContext']>(() => undefined),
  impact: last<S['impact']>(() => undefined),
  testCases: last<S['testCases']>(() => []),
  rtm: last<S['rtm']>(() => []),
  generated: last<S['generated']>(() => []),
  dataPlan: last<S['dataPlan']>(() => undefined),
  dataLedger: last<S['dataLedger']>(() => []),
  results: last<S['results']>(() => []),
  investigations: last<S['investigations']>(() => []),
  defects: last<S['defects']>(() => []),
  evidence: append<S['evidence'][number]>(),
  evalScores: last<S['evalScores']>(() => []),
  learnings: last<S['learnings']>(() => []),
  issues: Annotation<Issue[]>({ reducer: mergeIssues, default: () => [] }),
  status: last<S['status']>(() => 'RUNNING'),
  budget: last<S['budget']>(() => ({
    tokensUsed: 0,
    tokenLimit: 1,
    startedAt: new Date(0).toISOString(),
    timeLimitMin: 1,
  })),

  // ---- graph control (Phase 1)
  /** Ask the human (interrupt) — false for `--no-input`, CI and L3. */
  interactive: last<boolean>(() => true),
  coverage: last<CoverageRow[]>(() => []),
  /** Answering model environment of the analysis (MOCK must be labelled everywhere). */
  analysisEnvironment: last<'LIVE' | 'MOCK' | 'NONE'>(() => 'NONE'),
  analysisModels: last<string[]>(() => []),
  /** Nodes that run in degraded mode after triage chose `degrade`. */
  degradedNodes: last<string[]>(() => []),
  /** `${node}:${kind}` → how often each policy response was applied. */
  applied: last<Record<string, Partial<Record<PolicyResponse, number>>>>(() => ({})),
  lastNode: last<string>(() => 'START'),
  route: last<string>(() => ''),
  triageLog: append<TriageDecision>(),
  /** Human-readable progress notes (adapter fallbacks, skipped inputs …). */
  notes: append<string>(),
  /** Files written by the report node. */
  outputs: last<string[]>(() => []),
});

export type QAGraphStateType = typeof QAGraphState.State;
export type QAGraphUpdate = typeof QAGraphState.Update;
