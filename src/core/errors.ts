import type { IssueKind } from './schemas/issue.js';

/** The only reasons a run may stop hard (CLAUDE.md rule 4, PLAN.md §5). */
export type HardStopReason =
  | 'UNLISTED_ORG'
  | 'IDENTITY_MISMATCH'
  | 'PROFILE_FORBIDDEN_MUTATION'
  | 'METADATA_WRITE'
  | 'SECRET_IN_PROMPT'
  | 'UNTAGGED_CLEANUP';

/**
 * Raised only for safety hard stops. `resilientNode` converts it into status BLOCKED; the run then goes straight to
 * the report. Never use it for ordinary failures.
 */
export class HardStopError extends Error {
  override readonly name = 'HardStopError';
  constructor(
    readonly reason: HardStopReason,
    message: string,
  ) {
    super(`[HARD_STOP:${reason}] ${message}`);
  }
}

export class BudgetExceededError extends Error {
  override readonly name = 'BudgetExceededError';
  constructor(
    readonly budget: 'tokens' | 'time',
    readonly used: number,
    readonly limit: number,
  ) {
    super(`Budget exceeded: ${budget} ${used} > ${limit}`);
  }
}

/** A typed error whose IssueKind is known at the throw site. */
export class QAError extends Error {
  override readonly name: string = 'QAError';
  constructor(
    readonly kind: IssueKind,
    message: string,
    readonly detail?: Record<string, unknown>,
    options?: { cause?: unknown },
  ) {
    super(message, options);
  }
}

export class TimeoutError extends QAError {
  override readonly name = 'TimeoutError';
  constructor(what: string, ms: number) {
    super('TRANSIENT', `${what} timed out after ${ms} ms`, { timeoutMs: ms });
  }
}
