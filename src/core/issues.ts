import { randomUUID } from 'node:crypto';
import { classifyError } from './classifyError.js';
import type { Issue, IssueKind, IssueResolution } from './schemas/issue.js';

export interface NewIssue {
  kind: IssueKind;
  node: string;
  message: string;
  detail?: unknown;
  attempts?: number;
  resolution?: IssueResolution;
}

export function createIssue(input: NewIssue, now: Date = new Date()): Issue {
  return {
    id: `iss-${randomUUID().slice(0, 8)}`,
    kind: input.kind,
    node: input.node,
    message: input.message,
    ...(input.detail !== undefined ? { detail: input.detail } : {}),
    attempts: input.attempts ?? 1,
    ...(input.resolution ? { resolution: input.resolution } : {}),
    createdAt: now.toISOString(),
  };
}

/** Turn any thrown value into an Issue (classification + small secret-free detail). */
export function issueFromError(err: unknown, node: string, attempts = 1): Issue {
  const c = classifyError(err);
  return createIssue({ kind: c.kind, node, message: c.message, detail: c.detail, attempts });
}
