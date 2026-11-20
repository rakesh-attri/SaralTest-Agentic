import type { PolicyConfig, PolicyResponse } from '../../config/schemas.js';
import type { Issue, IssueResolution } from '../../core/schemas/index.js';

/**
 * QA Lead issue triage (PLAN.md §5, qa-lead-playbook). For each Issue: the next allowed response from
 * `config/policy.yaml` that (a) has not been exhausted, (b) was not already performed inside the failing component
 * (`detail.handled`), and (c) this node can actually perform. An optional reorder hook (e.g. an LLM) may reorder the
 * allowed list with a reason, but can never add a response that is not in the policy.
 */

/** What a node can do in response to an Issue. Responses a node cannot perform are skipped (next in policy order). */
export interface NodeCapabilities {
  retry: boolean;
  fallback: boolean;
  degrade: boolean;
  ask: boolean;
}

export interface TriageHistory {
  /** How often each response was already applied for this node + IssueKind. */
  applied: Partial<Record<PolicyResponse, number>>;
}

/**
 * `report-only`: no allowed response is applicable any more (all exhausted / not available in this phase). The issue
 * stays visible in the report for the human; nothing outside the policy list is ever *done*.
 */
export type TriageResponse = PolicyResponse | 'report-only';

export interface TriageDecision {
  issueId: string;
  node: string;
  kind: Issue['kind'];
  response: TriageResponse;
  resolution: IssueResolution;
  /** Seconds to wait before a retry (policy backoff). */
  delaySeconds?: number;
  reason: string;
}

export type ReorderHook = (
  issue: Issue,
  allowed: readonly PolicyResponse[],
) => Promise<{ order: string[]; reason: string } | undefined>;

const RESOLUTION: Record<PolicyResponse, IssueResolution> = {
  retry: 'RETRIED',
  fallback: 'FELL_BACK',
  degrade: 'DEGRADED',
  ask: 'ASKED',
  escalate: 'ESCALATED',
  halt: 'ESCALATED',
  investigate: 'ESCALATED',
  heal: 'ESCALATED',
  judge: 'ESCALATED',
  file_bug: 'ESCALATED',
};

/** Responses that belong to later phases' nodes (investigation, healing, defect judging). */
const LATER_PHASE: ReadonlySet<PolicyResponse> = new Set(['investigate', 'heal', 'judge', 'file_bug']);

function handledInside(issue: Issue): Set<string> {
  const d = issue.detail;
  if (d && typeof d === 'object' && 'handled' in d && Array.isArray(d.handled)) {
    return new Set(d.handled.filter((x): x is string => typeof x === 'string'));
  }
  return new Set();
}

function retryable(issue: Issue): boolean {
  const d = issue.detail;
  return !(d && typeof d === 'object' && 'retryable' in d && d.retryable === false);
}

/** Validate a reorder proposal: only responses from the policy list survive; missing ones keep policy order. */
export function applyReorder(
  allowed: readonly PolicyResponse[],
  proposal: readonly string[],
): { order: PolicyResponse[]; rejected: string[] } {
  const rejected = proposal.filter((p) => !(allowed as readonly string[]).includes(p));
  const picked = proposal.filter((p): p is PolicyResponse => (allowed as readonly string[]).includes(p));
  const order = [...new Set([...picked, ...allowed])];
  return { order, rejected };
}

export async function triageIssue(
  issue: Issue,
  policy: PolicyConfig,
  caps: NodeCapabilities,
  history: TriageHistory,
  reorder?: ReorderHook,
): Promise<TriageDecision> {
  const base = { issueId: issue.id, node: issue.node, kind: issue.kind };
  const allowed = policy.issues[issue.kind] ?? ['escalate'];
  let order: PolicyResponse[] = [...allowed];
  const notes: string[] = [];

  if (issue.kind === 'HARD_STOP') {
    return {
      ...base,
      response: 'halt',
      resolution: 'ESCALATED',
      reason: 'hard stop: halt and report BLOCKED (policy HARD_STOP: [halt])',
    };
  }
  if (reorder) {
    const proposal = await reorder(issue, allowed).catch(() => undefined);
    if (proposal) {
      const r = applyReorder(allowed, proposal.order);
      order = r.order;
      notes.push(`reordered: ${proposal.reason}`);
      if (r.rejected.length) notes.push(`rejected responses not in policy: ${r.rejected.join(', ')}`);
    }
  }

  const done = handledInside(issue);
  for (const response of order) {
    const used = history.applied[response] ?? 0;
    const skip = (why: string): void => {
      notes.push(`${response} skipped (${why})`);
    };
    if (done.has(response)) {
      skip('already done inside the component');
      continue;
    }
    if (LATER_PHASE.has(response)) {
      skip('handled by a later-phase agent');
      continue;
    }
    switch (response) {
      case 'retry': {
        if (!caps.retry || !retryable(issue)) {
          skip(caps.retry ? 'not retryable' : 'node cannot retry');
          continue;
        }
        if (used >= policy.retry.maxAttempts) {
          skip(`retry limit ${policy.retry.maxAttempts} reached`);
          continue;
        }
        const delaySeconds = policy.retry.backoffSeconds[Math.min(used, policy.retry.backoffSeconds.length - 1)] ?? 0;
        return {
          ...base,
          response,
          resolution: RESOLUTION[response],
          delaySeconds,
          reason: [...notes, `retry ${used + 1}/${policy.retry.maxAttempts} after ${delaySeconds}s`].join('; '),
        };
      }
      case 'fallback':
      case 'degrade':
      case 'ask':
        if (!caps[response]) {
          skip('not available for this node');
          continue;
        }
        if (used >= 1) {
          skip('already applied');
          continue;
        }
        return {
          ...base,
          response,
          resolution: RESOLUTION[response],
          reason: [...notes, `${response} (policy order for ${issue.kind})`].join('; '),
        };
      case 'escalate':
      case 'halt':
        return {
          ...base,
          response,
          resolution: RESOLUTION[response],
          reason: [...notes, `${response}: recorded for the human, run continues to the report`].join('; '),
        };
      default:
        skip('not applicable');
    }
  }
  return {
    ...base,
    response: 'report-only',
    resolution: 'ESCALATED',
    reason: [...notes, 'no applicable policy response left; reported for the human'].join('; '),
  };
}
