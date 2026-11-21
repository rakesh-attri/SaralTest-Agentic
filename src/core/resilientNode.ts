import { isGraphBubbleUp } from '@langchain/langgraph';
import { SpanStatusCode, trace, type Tracer } from '@opentelemetry/api';
import { runWithBudget, type BudgetTracker } from './budget.js';
import { classifyError } from './classifyError.js';
import { createIssue } from './issues.js';
import type { Logger } from './logger.js';
import type { QARunState } from './state.js';

/** The slice of run state every resilient node relies on. */
export type ResilientState = Pick<QARunState, 'runId' | 'issues' | 'status' | 'budget'>;

export interface NodeCtx {
  logger: Logger;
  budget: BudgetTracker;
  tracer?: Tracer;
  /** Extra trace attributes (agent, persona, storyKey…). */
  attributes?: Record<string, string>;
  signal?: AbortSignal;
}

export type NodeFn<S extends ResilientState> = (state: S, ctx: NodeCtx) => Promise<Partial<S>>;

/**
 * Wrap a graph node so it can never throw (CLAUDE.md rule 3).
 *
 * Update semantics (matches the Phase 1 LangGraph reducers): `issues` in the returned partial contains only NEW
 * issues — the state reducer appends them. `budget` is always the tracker's latest snapshot.
 *
 * - HardStopError → `status: 'BLOCKED'` + HARD_STOP issue (rule 4)
 * - BudgetExceededError (or time box already exhausted) → `status: 'PARTIAL'` + BUDGET issue
 * - anything else → classified Issue; QA Lead triage decides what happens next
 */
export interface ResilientOptions {
  /** Run even when the run is already BLOCKED (only the report node: every path ends at a report). */
  runWhenBlocked?: boolean;
}

export function resilientNode<S extends ResilientState>(
  name: string,
  fn: NodeFn<S>,
  options: ResilientOptions = {},
): NodeFn<S> {
  return async (state, ctx) => {
    const tracer = ctx.tracer ?? trace.getTracer('sf-qa-agent');
    return tracer.startActiveSpan(`node:${name}`, async (span) => {
      const started = performance.now();
      span.setAttributes({ 'qa.node': name, 'qa.runId': state.runId, ...ctx.attributes });
      const log = ctx.logger.child({ node: name, runId: state.runId });
      let update: Partial<S>;
      try {
        if (state.status === 'BLOCKED' && !options.runWhenBlocked) {
          // A hard stop already happened: no further work, only reporting.
          log.warn('skipped: run is BLOCKED');
          update = {};
        } else {
          if (state.status !== 'BLOCKED') ctx.budget.assertWithin();
          log.debug('start');
          // Model calls inside the node are charged to this run's budget (ModelRouter reads the active budget).
          const result = await runWithBudget(ctx.budget, () => fn(state, ctx));
          update = { ...result };
          span.setStatus({ code: SpanStatusCode.OK });
        }
      } catch (err) {
        // LangGraph control flow (interrupt() for clarification, Command) is not an error: let the graph handle it.
        if (isGraphBubbleUp(err)) {
          span.setAttribute('qa.interrupted', true);
          span.end();
          throw err;
        }
        const c = classifyError(err);
        const issue = createIssue({ kind: c.kind, node: name, message: c.message, detail: c.detail });
        span.setStatus({ code: SpanStatusCode.ERROR, message: c.kind });
        span.setAttribute('qa.issue.kind', c.kind);
        if (c.kind === 'HARD_STOP') {
          log.error({ issueId: issue.id, kind: c.kind }, `hard stop: ${c.message}`);
          update = { status: 'BLOCKED', issues: [issue] } as Partial<S>;
        } else if (c.kind === 'BUDGET') {
          log.warn({ issueId: issue.id, kind: c.kind }, c.message);
          update = { status: 'PARTIAL', issues: [issue] } as Partial<S>;
        } else {
          log.warn({ issueId: issue.id, kind: c.kind }, `issue raised: ${c.message}`);
          update = { issues: [issue] } as Partial<S>;
        }
      }
      const durationMs = Math.round(performance.now() - started);
      const budget = ctx.budget.snapshot();
      span.setAttributes({ 'qa.durationMs': durationMs, 'qa.tokensUsed': budget.tokensUsed });
      span.end();
      log.debug({ durationMs, tokensUsed: budget.tokensUsed }, 'end');
      return { ...update, budget };
    });
  };
}

/**
 * Reference reducer for node updates (append for `issues`, replace otherwise). Phase 1 expresses the same rules as
 * LangGraph channel reducers; this is used by tests and by simple sequential runners.
 */
export function applyUpdate<S extends ResilientState>(state: S, update: Partial<S>): S {
  const { issues, ...rest } = update;
  return { ...state, ...rest, issues: [...state.issues, ...(issues ?? [])] };
}
