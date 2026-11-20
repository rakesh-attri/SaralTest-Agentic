import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { InMemorySpanExporter, SimpleSpanProcessor, BasicTracerProvider } from '@opentelemetry/sdk-trace-base';
import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { BudgetTracker } from './budget.js';
import { classifyError } from './classifyError.js';
import { BudgetExceededError, HardStopError, QAError, TimeoutError } from './errors.js';
import { issueFromError } from './issues.js';
import { nullLogger } from './logger.js';
import { applyUpdate, resilientNode, type NodeCtx } from './resilientNode.js';
import { RetryExhaustedError, withRetry } from './retry.js';
import { ensureRunFolder, newRunId, runPaths } from './runFolder.js';
import { initialRunState, type QARunState } from './state.js';
import type { IssueKind } from './schemas/issue.js';

const withProps = (msg: string, props: Record<string, unknown>): Error => Object.assign(new Error(msg), props);

describe('classifyError', () => {
  const zodErr = z.object({ a: z.string() }).safeParse({ a: 1 }).error;
  const table: [string, unknown, IssueKind][] = [
    ['HardStopError', new HardStopError('UNLISTED_ORG', 'x'), 'HARD_STOP'],
    ['BudgetExceededError', new BudgetExceededError('tokens', 2, 1), 'BUDGET'],
    ['QAError keeps its kind', new QAError('AMBIGUOUS_SPEC', 'x'), 'AMBIGUOUS_SPEC'],
    ['TimeoutError', new TimeoutError('call', 10), 'TRANSIENT'],
    ['ZodError', zodErr, 'INVALID_LLM_OUTPUT'],
    ['ECONNRESET', withProps('reset', { code: 'ECONNRESET' }), 'TRANSIENT'],
    ['ECONNREFUSED', withProps('refused', { code: 'ECONNREFUSED' }), 'TOOL_UNAVAILABLE'],
    ['spawn ENOENT', withProps('spawn npx ENOENT', { code: 'ENOENT' }), 'TOOL_UNAVAILABLE'],
    ['ENOTFOUND', withProps('dns', { code: 'ENOTFOUND' }), 'ENVIRONMENT'],
    ['HTTP 401', withProps('unauthorized', { status: 401 }), 'AUTH'],
    ['HTTP 429', withProps('slow down', { statusCode: 429 }), 'TRANSIENT'],
    ['HTTP 503 via response', withProps('down', { response: { status: 503 } }), 'TRANSIENT'],
    ['HTTP 404', withProps('nope', { status: 404 }), 'UNKNOWN'],
    ['MCP -32001 timeout', withProps('MCP timeout', { code: -32001 }), 'TRANSIENT'],
    ['MCP -32000 closed', withProps('Connection closed', { code: -32000 }), 'TOOL_UNAVAILABLE'],
    ['MCP -32601 unknown tool', withProps('not found', { code: -32601 }), 'TOOL_UNAVAILABLE'],
    ['SF INVALID_SESSION_ID', withProps('session', { errorCode: 'INVALID_SESSION_ID' }), 'AUTH'],
    [
      'SF validation in body[]',
      withProps('bad', { body: [{ errorCode: 'FIELD_CUSTOM_VALIDATION_EXCEPTION' }] }),
      'DATA',
    ],
    ['SF UNABLE_TO_LOCK_ROW', withProps('lock', { errorCode: 'UNABLE_TO_LOCK_ROW' }), 'TRANSIENT'],
    ['Playwright strict mode', new Error('strict mode violation: getByRole resolved to 2'), 'LOCATOR'],
    ['AbortError', withProps('aborted', { name: 'AbortError' }), 'TRANSIENT'],
    ['rate-limit message', new Error('429 Too Many Requests'), 'TRANSIENT'],
    ['cause chain', new Error('wrapped', { cause: withProps('x', { status: 403 }) }), 'AUTH'],
    ['SF code only in text', new Error('INVALID_SESSION_ID: Session expired'), 'AUTH'],
    ['string thrown', 'boom', 'UNKNOWN'],
    ['undefined thrown', undefined, 'UNKNOWN'],
  ];
  it.each(table)('%s → %s', (_label, err, kind) => {
    expect(classifyError(err).kind).toBe(kind);
  });

  it('detail never carries raw payloads', () => {
    const c = classifyError(withProps('x', { status: 500, body: { secret: 'abc' } }));
    expect(c.detail).toEqual({ status: 500 });
  });

  it('issueFromError builds a schema-shaped Issue', () => {
    const i = issueFromError(new HardStopError('METADATA_WRITE', 'deploy'), 'build');
    expect(i).toMatchObject({ kind: 'HARD_STOP', node: 'build', attempts: 1 });
    expect(i.id).toMatch(/^iss-/);
  });
});

describe('withRetry', () => {
  const opts = { maxAttempts: 3, backoffSeconds: [2, 8, 30], sleep: vi.fn(() => Promise.resolve()) };

  it('retries TRANSIENT with policy backoff then succeeds', async () => {
    const sleeps: number[] = [];
    let n = 0;
    const r = await withRetry(
      () => {
        n++;
        if (n < 3) return Promise.reject(withProps('reset', { code: 'ECONNRESET' }));
        return Promise.resolve('ok');
      },
      {
        ...opts,
        sleep: (ms) => {
          sleeps.push(ms);
          return Promise.resolve();
        },
      },
    );
    expect(r).toBe('ok');
    expect(sleeps).toEqual([2000, 8000]);
  });

  it('does not retry non-transient errors', async () => {
    const fn = vi.fn(() => Promise.reject(withProps('denied', { status: 401 })));
    await expect(withRetry(fn, opts)).rejects.toThrow('denied');
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('throws RetryExhaustedError that still classifies as the original kind', async () => {
    const err = await withRetry(() => Promise.reject(withProps('reset', { code: 'ETIMEDOUT' })), opts).catch(
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(RetryExhaustedError);
    expect(classifyError(err).kind).toBe('TRANSIENT');
  });
});

describe('BudgetTracker', () => {
  const budget = { tokensUsed: 0, tokenLimit: 100, startedAt: new Date(0).toISOString(), timeLimitMin: 10 };

  it('records tokens and throws past the limit', () => {
    const b = new BudgetTracker(budget, () => 0);
    b.addTokens(60);
    expect(b.remainingTokens()).toBe(40);
    expect(() => {
      b.addTokens(50);
    }).toThrow(BudgetExceededError);
    expect(b.snapshot().tokensUsed).toBe(110);
  });

  it('enforces the time box', () => {
    const b = new BudgetTracker(budget, () => 11 * 60_000);
    expect(() => {
      b.assertWithin();
    }).toThrow(/time/);
  });
});

describe('run folders', () => {
  it('creates runs/<runId>/… under a path with spaces', async () => {
    const root = await mkdtemp(join(tmpdir(), 'qa run root '));
    const id = newRunId('run', new Date(2026, 10, 20, 14, 25, 30));
    expect(id).toMatch(/^run-20261120-142530-[0-9a-f]{4}$/);
    const p = await ensureRunFolder(root, id);
    expect((await stat(p.logs)).isDirectory()).toBe(true);
    expect(p.auditLog.endsWith(join(id, 'audit.jsonl'))).toBe(true);
    await rm(root, { recursive: true, force: true });
  });

  it('rejects run ids that would escape the runs folder', () => {
    expect(() => runPaths('/x', '../etc')).toThrow();
    expect(() => runPaths('/x', 'a/../../b')).toThrow();
  });
});

describe('resilientNode', () => {
  const mkState = (): QARunState =>
    initialRunState({
      runId: 'run-test',
      org: 'fixture',
      autonomy: 'L2',
      source: { type: 'chat', ref: 'test' },
      tokenLimit: 1000,
      timeLimitMin: 60,
    });
  const mkCtx = (tracerProvider?: BasicTracerProvider): NodeCtx => ({
    logger: nullLogger(),
    budget: new BudgetTracker(mkState().budget),
    ...(tracerProvider ? { tracer: tracerProvider.getTracer('test') } : {}),
  });

  it('passes through a successful update and records budget', async () => {
    const ctx = mkCtx();
    const node = resilientNode<QARunState>('ok', (_s, c) => {
      c.budget.addTokens(42);
      return Promise.resolve({ storyKey: 'SF-1' });
    });
    const u = await node(mkState(), ctx);
    expect(u.storyKey).toBe('SF-1');
    expect(u.budget?.tokensUsed).toBe(42);
  });

  it.each([
    ['plain Error', new Error('boom'), 'UNKNOWN'],
    ['TypeError', new TypeError('x is undefined'), 'UNKNOWN'],
    ['string', 'boom', 'UNKNOWN'],
    ['MCP closed', withProps('closed', { code: -32000 }), 'TOOL_UNAVAILABLE'],
  ] as const)('never throws (%s) and appends an Issue', async (_l, err, kind) => {
    // Deliberately rejects with non-Error values too: nodes must survive anything thrown.
    // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors
    const node = resilientNode<QARunState>('bad', () => Promise.reject(err));
    const s = mkState();
    const u = await node(s, mkCtx());
    expect(u.issues).toHaveLength(1);
    expect(u.issues?.[0]?.kind).toBe(kind);
    expect(u.status).toBeUndefined();
    expect(applyUpdate(s, u).issues).toHaveLength(1);
  });

  it('a synchronous throw inside the node is also caught', async () => {
    const node = resilientNode<QARunState>('sync', () => {
      throw new Error('sync boom');
    });
    const u = await node(mkState(), mkCtx());
    expect(u.issues?.[0]?.message).toBe('sync boom');
  });

  it('HardStopError → status BLOCKED (rule 4)', async () => {
    const node = resilientNode<QARunState>('discover', () =>
      Promise.reject(new HardStopError('IDENTITY_MISMATCH', 'wrong org')),
    );
    const u = await node(mkState(), mkCtx());
    expect(u.status).toBe('BLOCKED');
    expect(u.issues?.[0]?.kind).toBe('HARD_STOP');
  });

  it('a BLOCKED run does not execute further work nodes', async () => {
    const fn = vi.fn(() => Promise.resolve({}));
    const node = resilientNode<QARunState>('execute', fn);
    await node({ ...mkState(), status: 'BLOCKED' }, mkCtx());
    expect(fn).not.toHaveBeenCalled();
  });

  it('budget exhaustion → PARTIAL with BUDGET issue, work not started', async () => {
    const fn = vi.fn(() => Promise.resolve({}));
    const node = resilientNode<QARunState>('plan', fn);
    const ctx: NodeCtx = {
      logger: nullLogger(),
      budget: new BudgetTracker({ ...mkState().budget, tokensUsed: 5000 }),
    };
    const u = await node(mkState(), ctx);
    expect(fn).not.toHaveBeenCalled();
    expect(u.status).toBe('PARTIAL');
    expect(u.issues?.[0]?.kind).toBe('BUDGET');
  });

  it('emits one span per node with the issue kind', async () => {
    const exporter = new InMemorySpanExporter();
    const provider = new BasicTracerProvider({ spanProcessors: [new SimpleSpanProcessor(exporter)] });
    const node = resilientNode<QARunState>('investigate', () =>
      Promise.reject(withProps('x', { errorCode: 'DUPLICATES_DETECTED' })),
    );
    await node(mkState(), mkCtx(provider));
    const spans = exporter.getFinishedSpans();
    expect(spans).toHaveLength(1);
    expect(spans[0]?.name).toBe('node:investigate');
    expect(spans[0]?.attributes['qa.issue.kind']).toBe('DATA');
    expect(spans[0]?.attributes['qa.runId']).toBe('run-test');
  });
});
