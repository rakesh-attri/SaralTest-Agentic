import { defaultSleep } from '../core/retry.js';

/**
 * Sliding-window limiter: at most `perMinute` acquisitions in any 60 s window. Callers wait (never fail) so a busy
 * run slows down instead of tripping provider rate limits.
 */
export class RateLimiter {
  private readonly stamps: number[] = [];

  constructor(
    readonly perMinute: number,
    private readonly clock: () => number = Date.now,
    private readonly sleep: (ms: number) => Promise<void> = defaultSleep,
  ) {}

  async acquire(): Promise<void> {
    for (;;) {
      const now = this.clock();
      while (this.stamps.length && now - (this.stamps[0] ?? 0) >= 60_000) this.stamps.shift();
      if (this.stamps.length < this.perMinute) {
        this.stamps.push(now);
        return;
      }
      await this.sleep(60_000 - (now - (this.stamps[0] ?? now)) + 1);
    }
  }
}
