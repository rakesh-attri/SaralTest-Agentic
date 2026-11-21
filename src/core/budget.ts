import { AsyncLocalStorage } from 'node:async_hooks';
import { BudgetExceededError } from './errors.js';
import type { Budget } from './state.js';

/**
 * Tracks token and wall-clock budgets for one run (PLAN.md §5: BUDGET → stop new work, report PARTIAL).
 * Mutable and shared by the router and every node of a run.
 */
export class BudgetTracker {
  private tokensUsed: number;
  private readonly startedAtMs: number;

  constructor(
    private readonly budget: Budget,
    private readonly clock: () => number = Date.now,
  ) {
    this.tokensUsed = budget.tokensUsed;
    this.startedAtMs = Date.parse(budget.startedAt);
  }

  /** Records usage. Throws BudgetExceededError once the token limit is passed (usage is still recorded). */
  addTokens(n: number): void {
    if (!Number.isFinite(n) || n < 0) return;
    this.tokensUsed += Math.round(n);
    if (this.tokensUsed > this.budget.tokenLimit) {
      throw new BudgetExceededError('tokens', this.tokensUsed, this.budget.tokenLimit);
    }
  }

  elapsedMinutes(): number {
    return (this.clock() - this.startedAtMs) / 60_000;
  }

  /** Throws BudgetExceededError when the time box or token limit is already exhausted. */
  assertWithin(): void {
    const mins = this.elapsedMinutes();
    if (mins > this.budget.timeLimitMin) throw new BudgetExceededError('time', mins, this.budget.timeLimitMin);
    if (this.tokensUsed > this.budget.tokenLimit) {
      throw new BudgetExceededError('tokens', this.tokensUsed, this.budget.tokenLimit);
    }
  }

  remainingTokens(): number {
    return Math.max(0, this.budget.tokenLimit - this.tokensUsed);
  }

  snapshot(): Budget {
    return { ...this.budget, tokensUsed: this.tokensUsed };
  }
}

const activeBudget = new AsyncLocalStorage<BudgetTracker>();

/**
 * Run `fn` with `budget` as the active run budget. `resilientNode` wraps every graph node in this, so model calls
 * made anywhere inside a node are charged to that node's run, even though the ModelRouter is built before the graph
 * (and may serve several runs, e.g. in `qa chat`).
 */
export function runWithBudget<T>(budget: BudgetTracker, fn: () => T): T {
  return activeBudget.run(budget, fn);
}

/** The budget of the run whose node is currently executing, if any (the ModelRouter's default budget source). */
export function currentBudget(): BudgetTracker | undefined {
  return activeBudget.getStore();
}
