import { QAError } from '../core/errors.js';
import { defaultSleep } from '../core/retry.js';

export interface LimiterOptions {
  /** Tokens per minute (sliding 60 s window). Undefined = unlimited. */
  tokensPerMinute?: number | undefined;
  /**
   * Longest `acquire` waits before giving up with a rate-limited TRANSIENT error, so the caller can fail over to the
   * next provider instead of stalling. Default: wait as long as needed (embeddings / ingest keep that behaviour).
   */
  maxWaitMs?: number | undefined;
  /** Provider name, for messages. */
  name?: string | undefined;
}

/** An acquisition in the window; `settle` replaces the estimate with the real token count. */
export interface LimiterTicket {
  t: number;
  tokens: number;
}

const WINDOW_MS = 60_000;

/** The error a limiter (or a provider's HTTP 429) turns into: TRANSIENT, tagged so callers can fail over. */
export function rateLimitedError(provider: string, message: string, retryAfterMs: number, cause?: unknown): QAError {
  return new QAError(
    'TRANSIENT',
    message,
    { status: 429, rateLimited: true, provider, retryAfterMs: Math.round(retryAfterMs) },
    cause === undefined ? undefined : { cause },
  );
}

export function isRateLimited(err: unknown): boolean {
  return err instanceof QAError && err.detail?.['rateLimited'] === true;
}

/**
 * Sliding-window limiter per provider: requests/minute and tokens/minute. Callers wait while the wait is short; when it
 * would exceed `maxWaitMs`, when one request alone exceeds the token quota, or while the provider is cooling down
 * after an HTTP 429, `acquire` throws a rate-limited TRANSIENT error immediately (no network call) so the model chain
 * moves to the next provider.
 */
export class RateLimiter {
  private readonly window: LimiterTicket[] = [];
  private cooldownUntil = 0;
  readonly tokensPerMinute: number | undefined;
  readonly maxWaitMs: number;
  readonly name: string;

  constructor(
    readonly perMinute: number | undefined,
    private readonly clock: () => number = Date.now,
    private readonly sleep: (ms: number) => Promise<void> = defaultSleep,
    opts: LimiterOptions = {},
  ) {
    this.tokensPerMinute = opts.tokensPerMinute;
    this.maxWaitMs = opts.maxWaitMs ?? Number.POSITIVE_INFINITY;
    this.name = opts.name ?? 'provider';
  }

  private prune(now: number): void {
    while (this.window.length && now - (this.window[0]?.t ?? 0) >= WINDOW_MS) this.window.shift();
  }

  /** Milliseconds until a request of `tokens` fits (0 = now). */
  private waitFor(now: number, tokens: number): number {
    this.prune(now);
    let wait = Math.max(0, this.cooldownUntil - now);
    const rpm = this.perMinute;
    if (rpm !== undefined && this.window.length >= rpm) {
      const gate = this.window[this.window.length - rpm];
      if (gate) wait = Math.max(wait, gate.t + WINDOW_MS - now + 1);
    }
    const tpm = this.tokensPerMinute;
    if (tpm !== undefined) {
      let used = this.window.reduce((n, e) => n + e.tokens, 0);
      for (const e of this.window) {
        if (used + tokens <= tpm) break;
        used -= e.tokens;
        wait = Math.max(wait, e.t + WINDOW_MS - now + 1);
      }
    }
    return wait;
  }

  /** Remaining cooldown after a provider 429, in ms (0 when not cooling down). */
  cooldownRemaining(): number {
    return Math.max(0, this.cooldownUntil - this.clock());
  }

  /** The provider answered 429: no calls to it until `ms` from now. */
  cooldown(ms: number): void {
    this.cooldownUntil = Math.max(this.cooldownUntil, this.clock() + ms);
  }

  /**
   * Reserve one request of ~`estTokens` tokens. `maxWaitMs` overrides the limiter default for this call. While the
   * provider is cooling down after a 429 the call fails at once, unless `waitOnCooldown` (the last model of a chain:
   * nothing is left to fail over to, so it waits up to `maxWaitMs`).
   */
  async acquire(estTokens = 0, maxWaitMs: number = this.maxWaitMs, waitOnCooldown = false): Promise<LimiterTicket> {
    const cooling = this.cooldownRemaining();
    if (cooling > 0 && !waitOnCooldown) {
      throw rateLimitedError(
        this.name,
        `${this.name}: rate limited (cooling down after HTTP 429; next slot in ${Math.ceil(cooling / 1000)} s)`,
        cooling,
      );
    }
    const tpm = this.tokensPerMinute;
    if (tpm !== undefined && estTokens > tpm) {
      throw rateLimitedError(
        this.name,
        `${this.name}: request needs ~${estTokens} tokens, more than its ${tpm} tokens/minute quota`,
        WINDOW_MS,
      );
    }
    for (;;) {
      const now = this.clock();
      const wait = this.waitFor(now, estTokens);
      if (wait <= 0) {
        const ticket = { t: now, tokens: estTokens };
        this.window.push(ticket);
        return ticket;
      }
      if (wait > maxWaitMs) {
        const why = this.cooldownUntil > now ? 'cooling down after HTTP 429' : 'quota for this minute is used';
        throw rateLimitedError(
          this.name,
          `${this.name}: rate limited (${why}; next slot in ${Math.ceil(wait / 1000)} s)`,
          wait,
        );
      }
      await this.sleep(wait);
    }
  }

  /** Replace the estimate with the real token count once the provider reported usage. */
  settle(ticket: LimiterTicket | undefined, actualTokens: number): void {
    if (ticket) ticket.tokens = actualTokens;
  }
}
