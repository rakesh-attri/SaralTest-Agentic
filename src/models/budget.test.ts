import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { mockRouter } from '../../tests/helpers/mockRouter.js';
import { runStructured } from '../agents/shared/structured.js';
import { BudgetTracker, currentBudget } from '../core/budget.js';
import { nullLogger } from '../core/logger.js';
import { resilientNode, type NodeCtx } from '../core/resilientNode.js';
import { initialRunState, type QARunState } from '../core/state.js';

const state = (runId: string, tokenLimit = 100_000): QARunState =>
  initialRunState({
    runId,
    org: 'fixture',
    autonomy: 'L2',
    source: { type: 'chat', ref: 'test' },
    tokenLimit,
    timeLimitMin: 60,
  });
const ctx = (s: QARunState): NodeCtx => ({ logger: nullLogger(), budget: new BudgetTracker(s.budget) });

describe('run budget ← ModelRouter (router built before the graph, no explicit budget)', () => {
  it('model calls inside a node are charged to that run and land in the state snapshot', async () => {
    const router = await mockRouter({ reasoning: { responder: () => '{"ok":true}' } });
    const s = state('run-a');
    const node = resilientNode<QARunState>('understand', async () => {
      await runStructured({
        router,
        role: 'reasoning',
        agent: 't',
        schema: z.object({ ok: z.boolean() }),
        system: 'Answer.',
        user: 'Go.',
      });
      return {};
    });
    const u = await node(s, ctx(s));
    expect(u.budget?.tokensUsed).toBeGreaterThan(0);
    expect(u.budget?.tokensUsed).toBe(router.totalTokens());
  });

  it('concurrent runs are charged separately', async () => {
    const router = await mockRouter();
    const a = state('run-a');
    const b = state('run-b');
    const ca = ctx(a);
    const cb = ctx(b);
    const call = (prompt: string) =>
      resilientNode<QARunState>('n', async () => {
        await router.get('fast').invoke(prompt);
        return {};
      });
    await Promise.all([call('short')(a, ca), call('x'.repeat(4000))(b, cb)]);
    const ta = ca.budget.snapshot().tokensUsed;
    const tb = cb.budget.snapshot().tokensUsed;
    expect(ta).toBeGreaterThan(0);
    expect(tb).toBeGreaterThan(ta * 10);
    expect(ta + tb).toBe(router.totalTokens());
  });

  it('a run that passes its token limit ends PARTIAL with a BUDGET issue', async () => {
    const router = await mockRouter();
    const s = state('run-small', 50);
    const node = resilientNode<QARunState>('n', async () => {
      await router.get('fast').invoke('y'.repeat(1000));
      return {};
    });
    const u = await node(s, ctx(s));
    expect(u.status).toBe('PARTIAL');
    expect(u.issues?.[0]?.kind).toBe('BUDGET');
  });

  it('outside a node nothing is charged and nothing fails (doctor, ad-hoc calls)', async () => {
    const router = await mockRouter();
    expect(currentBudget()).toBeUndefined();
    await expect(router.get('fast').invoke('hi')).resolves.toBeDefined();
  });
});
