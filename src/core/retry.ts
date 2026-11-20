import { classifyError } from './classifyError.js';
import type { IssueKind } from './schemas/issue.js';

export interface RetryOptions {
  /** Total attempts including the first. From policy.yaml `retry.maxAttempts`. */
  maxAttempts: number;
  /** Delay before retry n (seconds); the last value repeats. From policy.yaml `retry.backoffSeconds`. */
  backoffSeconds: readonly number[];
  /** Which kinds are worth retrying. Default: TRANSIENT only — never blind-retry writes (safety skill). */
  retryOn?: readonly IssueKind[];
  sleep?: (ms: number) => Promise<void>;
  onRetry?: (info: { attempt: number; delayMs: number; kind: IssueKind; message: string }) => void;
}

export const defaultSleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

export class RetryExhaustedError extends Error {
  override readonly name = 'RetryExhaustedError';
  constructor(
    readonly attempts: number,
    readonly lastError: unknown,
  ) {
    super(`gave up after ${attempts} attempts: ${lastError instanceof Error ? lastError.message : String(lastError)}`, {
      cause: lastError,
    });
  }
}

/**
 * Retry an operation with policy backoff. Non-retryable errors are rethrown immediately (unchanged) so the caller's
 * classification still works; exhausted retries throw RetryExhaustedError whose `cause` keeps the original kind.
 */
export async function withRetry<T>(fn: (attempt: number) => Promise<T>, opts: RetryOptions): Promise<T> {
  const retryOn = opts.retryOn ?? ['TRANSIENT'];
  const sleep = opts.sleep ?? defaultSleep;
  let lastError: unknown;
  for (let attempt = 1; attempt <= opts.maxAttempts; attempt++) {
    try {
      return await fn(attempt);
    } catch (err) {
      lastError = err;
      const c = classifyError(err);
      if (!retryOn.includes(c.kind)) throw err;
      if (attempt === opts.maxAttempts) break;
      const secs = opts.backoffSeconds[Math.min(attempt - 1, opts.backoffSeconds.length - 1)] ?? 0;
      const delayMs = secs * 1000;
      opts.onRetry?.({ attempt, delayMs, kind: c.kind, message: c.message });
      await sleep(delayMs);
    }
  }
  throw new RetryExhaustedError(opts.maxAttempts, lastError);
}
