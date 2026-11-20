import { END, START, StateGraph, interrupt, type BaseCheckpointSaver } from '@langchain/langgraph';
import type { Tracer } from '@opentelemetry/api';
import { analyzeSpec } from '../agents/spec-analyst/graph.js';
import { RequirementIdStore } from '../agents/spec-analyst/ids.js';
import { triageIssue, type NodeCapabilities, type ReorderHook, type TriageDecision } from '../agents/qa-lead/triage.js';
import type { PolicyConfig } from '../config/schemas.js';
import { BudgetTracker } from '../core/budget.js';
import { classifyError } from '../core/classifyError.js';
import { createIssue } from '../core/issues.js';
import type { Logger } from '../core/logger.js';
import { resilientNode, type NodeCtx } from '../core/resilientNode.js';
import { ensureRunFolder } from '../core/runFolder.js';
import type { Clarification, EvidenceEntry, Issue, Requirement } from '../core/schemas/index.js';
import { resolveInput, type AdapterContext } from '../inputs/index.js';
import type { ModelRouter } from '../models/router.js';
import type { Redactor } from '../security/redact.js';
import type { SkillLoader } from '../skills/skillLoader.js';
import { finalStatus, writeAnalysisReport } from './analysisReport.js';
import { QAGraphState, type QAGraphStateType, type QAGraphUpdate } from './state.js';

/**
 * Main graph (PLAN.md §2), Phase 1 + 2:
 *   START → intake → understand ⇄ clarify(interrupt) → discover (if an org is set) → report → END, with QA Lead
 *   triage after every node.
 * Later phases insert plan/build/execute… between discover and report. Every path ends at `report`.
 */

export interface GraphDeps {
  root: string;
  policy: PolicyConfig;
  logger: Logger;
  router?: ModelRouter;
  skills?: SkillLoader;
  redactor?: Redactor;
  /** Adapter context minus logger (added here). */
  adapter: Omit<AdapterContext, 'logger'>;
  /** `.qa-memory` folder (stable requirement ids). */
  memoryDir: string;
  checkpointer?: BaseCheckpointSaver;
  tracer?: Tracer;
  /** Retry backoff sleep (tests inject a no-op). */
  sleep?: (ms: number) => Promise<void>;
  reorder?: ReorderHook;
  /** Max understand ⇄ clarify rounds with human answers (default 2). */
  maxClarifyRounds?: number;
  onProgress?: (msg: string) => void;
  /**
   * Phase 2 Salesforce Intelligence: discovery + org cross-check of the analysed requirements. Absent → the graph
   * skips `discover` (analysis-only runs, `--offline`).
   */
  discover?: DiscoverHook;
}

export interface DiscoverHookResult {
  org: string;
  orgContext: QAGraphStateType['orgContext'];
  impact: QAGraphStateType['impact'];
  /** New org findings (ORG_CONFLICT / ORG_NOT_FOUND / ORG_CHECK_NEEDED). */
  findings: QAGraphStateType['findings'];
  evidence: EvidenceEntry[];
  notes: string[];
}
export type DiscoverHook = (
  s: Pick<QAGraphStateType, 'runId' | 'requirements' | 'findings' | 'existingTests'>,
) => Promise<DiscoverHookResult>;

/** Clarification interrupt payload / resume value (CLI, chat REPL, `qa resume`). */
export interface ClarifyRequest {
  kind: 'clarification';
  runId: string;
  round: number;
  questions: Clarification[];
}
export interface ClarifyAnswer {
  /** question id → answer text; missing / empty / "skip" → assumed. */
  answers: Record<string, string>;
  /** True when the wait time passed without (all) answers. */
  timedOut?: boolean;
}

const CAPS: Record<string, NodeCapabilities> = {
  intake: { retry: true, fallback: false, degrade: true, ask: false },
  understand: { retry: true, fallback: false, degrade: true, ask: true },
  clarify: { retry: false, fallback: false, degrade: true, ask: false },
  // Discovery failing degrades to "no org context" (requirements stay as analysed); hard stops still block.
  discover: { retry: true, fallback: false, degrade: true, ask: false },
  report: { retry: false, fallback: false, degrade: false, ask: false },
};

const SKIP_ANSWER = /^\s*(?:|skip|-|n\/a|idk|don'?t know|unknown)\s*$/i;

/** Mark assumed / answered questions on the requirements they affect (deterministic, no model). */
export function applyClarifications(reqs: readonly Requirement[], clars: readonly Clarification[]): Requirement[] {
  return reqs.map((r) => {
    let reasons = [...r.reviewReasons];
    const known = [...r.assumptions.known];
    for (const c of clars) {
      if (!c.requirementIds.includes(r.id)) continue;
      const openTag = `open question ${c.id}`;
      if (c.status === 'ASSUMED' && reasons.includes(openTag)) {
        reasons = reasons.map((x) => (x === openTag ? `relies on unconfirmed assumption ${c.id}` : x));
        known.push(`ASSUMPTION (unconfirmed, ${c.id}): ${c.assumption ?? c.proposedAssumption ?? ''}`);
      }
      if (c.status === 'ANSWERED' && reasons.includes(openTag)) {
        reasons = reasons.map((x) => (x === openTag ? `answered ${c.id}; re-analysis pending` : x));
      }
    }
    return { ...r, reviewReasons: reasons, assumptions: { ...r.assumptions, known: [...new Set(known)] } };
  });
}

export function buildMainGraph(deps: GraphDeps) {
  const budgets = new Map<string, BudgetTracker>();
  const ctxFor = (s: QAGraphStateType, agent: string): NodeCtx => {
    let b = budgets.get(s.runId);
    if (!b) {
      b = new BudgetTracker(s.budget);
      budgets.set(s.runId, b);
    }
    return {
      logger: deps.logger,
      budget: b,
      ...(deps.tracer ? { tracer: deps.tracer } : {}),
      attributes: { 'qa.agent': agent, ...(s.storyKey ? { 'qa.storyKey': s.storyKey } : {}) },
    };
  };
  const say = (m: string): void => deps.onProgress?.(m);
  const maxRounds = deps.maxClarifyRounds ?? 2;
  type Node = (s: QAGraphStateType) => Promise<QAGraphUpdate>;
  const wrap = (
    name: string,
    agent: string,
    fn: (s: QAGraphStateType) => QAGraphUpdate | Promise<QAGraphUpdate>,
    runWhenBlocked = false,
  ): Node => {
    const node = resilientNode<QAGraphStateType>(name, async (s) => (await fn(s)) as Partial<QAGraphStateType>, {
      runWhenBlocked,
    });
    return async (s) => ({ ...(await node(s, ctxFor(s, agent))), lastNode: name });
  };

  // ------------------------------------------------------------------ intake
  const intake = wrap('intake', 'qa-lead', async (s) => {
    const ctx: AdapterContext = { ...deps.adapter, logger: deps.logger };
    const out = {
      sources: [] as QAGraphStateType['sources'],
      existingTests: [] as QAGraphStateType['existingTests'],
      defectHistory: [] as QAGraphStateType['defectHistory'],
      changedComponents: [] as QAGraphStateType['changedComponents'],
      objectives: [] as QAGraphStateType['objectives'],
    };
    const issues: Issue[] = [];
    const notes: string[] = [];
    for (const req of s.inputs) {
      const label = req.kind === 'chat' ? 'chat text' : req.value;
      say(`Reading ${req.kind} input ${label} …`);
      try {
        const r = await resolveInput(req, ctx);
        out.sources.push(...r.documents);
        out.existingTests.push(...r.tests);
        out.defectHistory.push(...r.defects);
        out.changedComponents.push(...r.changes);
        out.objectives.push(...r.objectives);
        notes.push(
          `${req.kind} ${label} → via ${r.via}: ${r.documents.length} document(s), ${r.tests.length} test(s)`,
          ...r.notes,
        );
        say(`  ✓ via ${r.via}${r.notes.length ? ` (${r.notes.join('; ')})` : ''}`);
      } catch (err) {
        const c = classifyError(err);
        if (c.kind === 'HARD_STOP') throw err;
        issues.push(
          createIssue({
            kind: c.kind,
            node: 'intake',
            message: `${req.kind} input "${label}": ${c.message}`,
            detail: { ...c.detail, input: req, retryable: c.kind !== 'DATA' },
          }),
        );
        say(`  ✗ ${c.kind}: ${c.message}`);
      }
    }
    const jira = out.sources.find((d) => d.source.type === 'jira');
    const story: QAGraphStateType['story'] = jira
      ? {
          key: jira.docId,
          summary: jira.title,
          description: jira.sections
            .filter((x) => x.kind === 'description' || x.kind === 'text')
            .map((x) => x.text)
            .join('\n'),
          acceptanceCriteria: jira.sections.filter((x) => x.kind === 'ac').map((x) => `${x.ref}: ${x.text}`),
          links: Array.isArray(jira.meta['links'])
            ? jira.meta['links'].filter((l): l is string => typeof l === 'string')
            : [],
        }
      : undefined;
    const storyKey = s.storyKey ?? jira?.docId ?? out.sources[0]?.docId;
    return { ...out, ...(story ? { story } : {}), ...(storyKey ? { storyKey } : {}), issues, notes };
  });

  // ------------------------------------------------------------------ understand (Spec Analyst)
  const understand = wrap('understand', 'spec-analyst', async (s) => {
    const mechanical = s.degradedNodes.includes('understand') || !deps.router;
    say(
      `Analysing ${s.sources.length} source(s)${mechanical ? ' mechanically (no model)' : ''} — round ${s.clarifyRound + 1} …`,
    );
    const key = s.storyKey ?? s.sources[0]?.docId ?? 'REQ';
    const res = await analyzeSpec(
      {
        key,
        sources: s.sources,
        existingTests: s.existingTests,
        clarifications: s.clarifications,
        round: s.clarifyRound + 1,
        mode: mechanical ? 'mechanical' : 'llm',
      },
      {
        ...(deps.router ? { router: deps.router } : {}),
        ...(deps.skills ? { skills: deps.skills } : {}),
        ...(deps.redactor ? { redactor: deps.redactor } : {}),
        logger: deps.logger,
        ids: new RequirementIdStore(key, deps.memoryDir),
        maxQuestions: deps.policy.clarification.maxQuestionsPerRound,
      },
    );
    const issues: Issue[] = res.degraded.map((d) =>
      createIssue({ kind: d.kind, node: 'understand', message: d.message, resolution: 'DEGRADED' }),
    );
    if (mechanical) {
      issues.push(
        createIssue({
          kind: deps.router ? 'INVALID_LLM_OUTPUT' : 'TOOL_UNAVAILABLE',
          node: 'understand',
          message: deps.router
            ? 'requirements derived mechanically (model output unusable after retries and fallback); all REVIEW_REQUIRED'
            : 'requirements derived mechanically (no model: offline or not configured); all REVIEW_REQUIRED',
          resolution: 'DEGRADED',
        }),
      );
    }
    if (res.questions.length) {
      issues.push(
        createIssue({
          kind: 'AMBIGUOUS_SPEC',
          node: 'understand',
          message: `${res.questions.length} clarification question(s): ${res.questions.map((q) => q.id).join(', ')}`,
          detail: { questions: res.questions.map((q) => q.id) },
        }),
      );
    }
    say(
      `  ✓ ${res.requirements.length} requirements (${res.requirements.filter((r) => r.status === 'REVIEW_REQUIRED').length} review required), ${res.findings.length} findings, ${res.questions.length} question(s) [${res.environment}]`,
    );
    const kept = s.clarifications.filter((c) => c.status !== 'OPEN');
    return {
      requirements: res.requirements,
      findings: res.findings,
      clarifications: [...kept, ...res.questions],
      coverage: res.coverage,
      evidence: res.evidence,
      analysisEnvironment:
        res.environment === 'NONE' && s.analysisEnvironment !== 'NONE' ? s.analysisEnvironment : res.environment,
      analysisModels: [...new Set([...s.analysisModels, ...res.models])],
      issues,
    };
  });

  // ------------------------------------------------------------------ clarify (human checkpoint)
  const clarify = wrap('clarify', 'qa-lead', (s) => {
    const open = s.clarifications.filter((c) => c.status === 'OPEN');
    if (!open.length) return {};
    const round = s.clarifyRound + 1;
    const ask = s.interactive && s.autonomy !== 'L3';
    let answer: ClarifyAnswer = { answers: {}, timedOut: true };
    if (ask) {
      answer = interrupt<ClarifyRequest, ClarifyAnswer>({
        kind: 'clarification',
        runId: s.runId,
        round,
        questions: open,
      });
    }
    const why = !ask
      ? s.autonomy === 'L3'
        ? 'autonomy L3: no wait'
        : 'non-interactive run (--no-input)'
      : answer.timedOut
        ? 'no answer received (wait time over or input ended)'
        : 'question skipped by the human';
    const clarifications = s.clarifications.map((c): Clarification => {
      if (c.status !== 'OPEN') return c;
      const a = answer.answers[c.id];
      if (a !== undefined && !SKIP_ANSWER.test(a)) return { ...c, status: 'ANSWERED', answer: a.trim() };
      return {
        ...c,
        status: 'ASSUMED',
        assumption: c.proposedAssumption ?? 'unconfirmed: treat as review-required, do not assert',
      };
    });
    const now = new Date().toISOString();
    const evidence: EvidenceEntry[] = clarifications
      .filter((c) => open.some((o) => o.id === c.id))
      .map((c) => ({
        id: `EV-${c.id}`,
        claim:
          c.status === 'ANSWERED'
            ? `${c.id} answered by the human: ${c.answer ?? ''}`
            : `${c.id} assumed (${why}): ${c.assumption ?? ''}`,
        sources: [c.id, ...c.refs],
        agent: 'qa-lead',
        confidence: c.status === 'ANSWERED' ? 0.95 : 0.4,
        environment: 'LIVE',
        createdAt: now,
      }));
    const answered = clarifications.filter((c) => c.status === 'ANSWERED' && open.some((o) => o.id === c.id)).length;
    say(`  ✓ ${answered} answered, ${open.length - answered} assumed (${why})`);
    // Resolve the AMBIGUOUS_SPEC issue: asked (answers) or degraded (continue with flagged assumptions).
    const issues = s.issues
      .filter((i) => i.kind === 'AMBIGUOUS_SPEC' && i.resolution === 'ASKED')
      .map((i) => ({ ...i, resolution: answered === open.length ? ('ASKED' as const) : ('DEGRADED' as const) }));
    return {
      clarifications,
      requirements: applyClarifications(s.requirements, clarifications),
      clarifyRound: round,
      evidence,
      issues,
    };
  });

  // ------------------------------------------------------------------ discover (Phase 2)
  const discover = wrap('discover', 'sf-intelligence', async (s) => {
    if (!deps.discover) return {};
    const r = await deps.discover({
      runId: s.runId,
      requirements: s.requirements,
      findings: s.findings,
      existingTests: s.existingTests,
    });
    for (const n of r.notes) say(n);
    const known = new Set(s.findings.map((f) => f.id));
    return {
      org: r.org,
      orgContext: r.orgContext,
      impact: r.impact,
      findings: [...s.findings, ...r.findings.filter((f) => !known.has(f.id))],
      evidence: r.evidence,
      notes: r.notes,
    };
  });

  // ------------------------------------------------------------------ report
  const report = wrap(
    'report',
    'reporter',
    async (s) => {
      const status = finalStatus(s);
      const paths = await ensureRunFolder(deps.root, s.runId);
      const outputs = await writeAnalysisReport(s, paths.dir, status);
      say(`Report written: ${outputs.find((o) => o.endsWith('.md')) ?? paths.dir}`);
      return { status, outputs };
    },
    true,
  );

  // ------------------------------------------------------------------ QA Lead triage (after every node)
  const triage = async (s: QAGraphStateType): Promise<QAGraphUpdate> => {
    const node = s.lastNode;
    const pending = s.issues.filter((i) => i.node === node && !i.resolution);
    const decisions: TriageDecision[] = [];
    const applied = { ...s.applied };
    const updated: Issue[] = [];
    let degradedNodes = s.degradedNodes;
    for (const issue of pending) {
      const key = `${node}:${issue.kind}`;
      const d = await triageIssue(
        issue,
        deps.policy,
        CAPS[node] ?? CAPS['report'] ?? { retry: false, fallback: false, degrade: false, ask: false },
        { applied: applied[key] ?? {}, askLimit: maxRounds },
      );
      decisions.push(d);
      if (d.response !== 'report-only')
        applied[key] = { ...applied[key], [d.response]: (applied[key]?.[d.response] ?? 0) + 1 };
      updated.push({ ...issue, resolution: d.resolution, attempts: issue.attempts + (d.response === 'retry' ? 1 : 0) });
      if (d.response === 'degrade' && (node === 'understand' || node === 'discover') && !degradedNodes.includes(node))
        degradedNodes = [...degradedNodes, node];
      say(`QA Lead: ${issue.kind} at ${node} → ${d.response} (${d.reason})`);
    }
    const has = (r: string): TriageDecision | undefined => decisions.find((d) => d.response === r);
    let route: string;
    if (s.status === 'BLOCKED' || has('halt')) route = 'report';
    else if (has('retry')) {
      const delay = Math.max(...decisions.filter((d) => d.response === 'retry').map((d) => d.delaySeconds ?? 0));
      if (delay > 0) await (deps.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms))))(delay * 1000);
      route = node;
    } else if (has('degrade') && node === 'understand' && !s.requirements.length) route = 'understand';
    else if (has('ask')) route = 'clarify';
    else route = nextAfter(node, s);
    const now = new Date().toISOString();
    return {
      issues: updated,
      triageLog: decisions,
      applied,
      degradedNodes,
      route,
      evidence: decisions.map((d) => ({
        id: `EV-TRIAGE-${d.issueId}-${applied[`${d.node}:${d.kind}`]?.[d.response as keyof (typeof applied)[string]] ?? 0}`,
        claim: `QA Lead triage ${d.issueId} ${d.kind} at ${d.node} → ${d.response}: ${d.reason}`,
        sources: [d.issueId, 'config/policy.yaml'],
        agent: 'qa-lead',
        confidence: 1,
        environment: 'LIVE' as const,
        createdAt: now,
      })),
    };
  };

  /** After analysis: discover (when an org is configured for the run) → report. */
  const afterAnalysis = (s: QAGraphStateType): string =>
    deps.discover && s.requirements.length && !s.degradedNodes.includes('discover') ? 'discover' : 'report';

  function nextAfter(node: string, s: QAGraphStateType): string {
    switch (node) {
      case 'intake':
        return s.sources.length ? 'understand' : 'report';
      case 'understand':
        return s.clarifications.some((c) => c.status === 'OPEN') ? 'clarify' : afterAnalysis(s);
      case 'clarify': {
        const newAnswers = s.clarifications.some((c) => c.status === 'ANSWERED' && c.round === s.clarifyRound);
        return newAnswers && s.clarifyRound < maxRounds ? 'understand' : afterAnalysis(s);
      }
      default:
        return 'report';
    }
  }

  const routes = ['intake', 'understand', 'clarify', 'discover', 'report'] as const;
  const graph = new StateGraph(QAGraphState)
    .addNode('intake', intake)
    .addNode('understand', understand)
    .addNode('clarify', clarify)
    .addNode('discover', discover)
    .addNode('report', report)
    .addNode('triage', triage)
    .addEdge(START, 'intake')
    .addEdge('intake', 'triage')
    .addEdge('understand', 'triage')
    .addEdge('clarify', 'triage')
    .addEdge('discover', 'triage')
    .addConditionalEdges(
      'triage',
      (s) => ((routes as readonly string[]).includes(s.route) ? (s.route as (typeof routes)[number]) : 'report'),
      [...routes],
    )
    .addEdge('report', END);
  return graph.compile(deps.checkpointer ? { checkpointer: deps.checkpointer } : {});
}

export type MainGraph = ReturnType<typeof buildMainGraph>;
