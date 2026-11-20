import { AIMessage, HumanMessage } from '@langchain/core/messages';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { BudgetTracker } from '../core/budget.js';
import { classifyError } from '../core/classifyError.js';
import { HardStopError, QAError } from '../core/errors.js';
import { ModelsConfig, type ModelRole } from '../config/schemas.js';
import type { EnvKey } from '../config/env.js';
import { suggestGeminiModels } from './listModels.js';
import { MOCK_DEFAULT_RESPONSE, type MockOptions } from './mock.js';
import type { ProviderSecrets } from './providers/index.js';
import { RateLimiter } from './rateLimiter.js';
import { ModelRouter, type RouterOptions } from './router.js';

const SECRET = 'AIzaSy-test-secret-value-123';

function secrets(values: Partial<Record<EnvKey, string>> = {}): ProviderSecrets {
  return { get: (k) => Promise.resolve(values[k]), setting: (k) => values[k] };
}

function mockConfig(over: Record<string, unknown> = {}): ModelsConfig {
  return ModelsConfig.parse({
    roles: {
      reasoning: { provider: 'mock', model: 'mock-pro', fallback: { provider: 'mock', model: 'mock-flash' } },
      coder: { provider: 'mock', model: 'mock-flash' },
      fast: { provider: 'mock', model: 'mock-lite' },
      judge: { provider: 'mock', model: 'mock-pro' },
    },
    embeddings: { provider: 'mock', model: 'mock-embed' },
    budgets: { tokensPerRun: 1000, minutesPerRun: 10 },
    ...over,
  });
}

async function router(
  opts: Partial<RouterOptions> & { mock?: Partial<Record<ModelRole, MockOptions>> } = {},
): Promise<ModelRouter> {
  return ModelRouter.create({
    config: mockConfig(),
    secrets: secrets(),
    secretValues: () => [SECRET],
    ...opts,
  });
}

describe('ModelRouter — roles and labelling', () => {
  it('maps each role to its configured model and labels mock output MOCK', async () => {
    const r = await router();
    const res = await r.get('coder').invoke('hello');
    expect(res.content).toBe(MOCK_DEFAULT_RESPONSE);
    expect(res.response_metadata['environment']).toBe('MOCK');
    expect(res.response_metadata['model']).toBe('mock-flash');
    expect(r.isMock('coder')).toBe(true);
    expect(r.status().every((s) => s.ok)).toBe(true);
  });

  it('rejects a config where judge == coder (rule 8)', () => {
    expect(() =>
      mockConfig({
        roles: {
          reasoning: { provider: 'mock', model: 'a' },
          coder: { provider: 'mock', model: 'same' },
          fast: { provider: 'mock', model: 'b' },
          judge: { provider: 'mock', model: 'same' },
        },
      }),
    ).toThrow(/judge must use a different model/);
  });

  it('placeholder model ids → TOOL_UNAVAILABLE on use, router still constructs', async () => {
    const r = await router({
      config: mockConfig({
        roles: {
          reasoning: { provider: 'google', model: '<gemini-pro-model-id>' },
          coder: { provider: 'mock', model: 'm1' },
          fast: { provider: 'mock', model: 'm2' },
          judge: { provider: 'mock', model: 'm3' },
        },
      }),
    });
    expect(() => r.get('reasoning')).toThrow(QAError);
    const err = (() => {
      try {
        r.get('reasoning');
      } catch (e) {
        return e;
      }
    })();
    expect(classifyError(err).kind).toBe('TOOL_UNAVAILABLE');
    expect(r.status().find((s) => s.role === 'reasoning')?.ok).toBe(false);
    expect(r.get('coder')).toBeDefined();
  });

  it('missing provider key → TOOL_UNAVAILABLE naming the key, no network call', async () => {
    const r = await router({
      config: mockConfig({
        roles: {
          reasoning: { provider: 'google', model: 'gemini-x' },
          coder: { provider: 'mock', model: 'm1' },
          fast: { provider: 'mock', model: 'm2' },
          judge: { provider: 'mock', model: 'm3' },
        },
      }),
    });
    expect(r.status().find((s) => s.role === 'reasoning')?.error).toMatch(/GOOGLE_API_KEY is not set/);
  });

  it('builds a real Google model when the key exists (lazy import, no call made)', async () => {
    const r = await router({
      secrets: secrets({ GOOGLE_API_KEY: 'fake-key-for-construction' }),
      config: mockConfig({
        roles: {
          reasoning: { provider: 'google', model: 'gemini-x-pro' },
          coder: { provider: 'mock', model: 'm1' },
          fast: { provider: 'mock', model: 'm2' },
          judge: { provider: 'mock', model: 'm3' },
        },
      }),
    });
    expect(r.get('reasoning')._llmType()).toBe('guarded:googlegenerativeai');
    expect(r.isMock('reasoning')).toBe(false);
  });
});

describe('ModelRouter — fallback', () => {
  it('falls back to the fallback model when the primary fails', async () => {
    const r = await router({
      mock: { reasoning: { failFirst: { times: 99, error: () => new Error('503 overloaded') } } },
    });
    // primary is scripted to fail; the fallback mock is unscripted and answers
    const out = await r.withFallback('reasoning').invoke('plan this');
    expect(out.content).toBe(MOCK_DEFAULT_RESPONSE);
  });

  it('never falls back on a hard stop', async () => {
    const r = await router();
    await expect(r.withFallback('reasoning').invoke(`leak ${SECRET}`)).rejects.toBeInstanceOf(HardStopError);
  });

  it('applies the same builder (structured output) to primary and fallback', async () => {
    const schema = z.object({ verdict: z.string() });
    const toolResponder = (): AIMessage =>
      new AIMessage({ content: '', tool_calls: [{ id: 'c1', name: 'extract', args: { verdict: 'PASS' } }] });
    const r = await router({
      mock: {
        reasoning: { failFirst: { times: 99, error: () => new Error('invalid JSON from model') } },
        'reasoning:fallback': { responder: toolResponder },
      },
    });
    const structured = r.withFallback('reasoning', (m) => m.withStructuredOutput(schema, { name: 'extract' }));
    await expect(structured.invoke('judge it')).resolves.toEqual({ verdict: 'PASS' });
  });
});

describe('ModelRouter — guards', () => {
  it('hard-stops when a secret value is in the prompt (rule 4)', async () => {
    const r = await router();
    const err = await r
      .get('fast')
      .invoke([new HumanMessage(`token is ${SECRET}`)])
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(HardStopError);
    expect((err as HardStopError).reason).toBe('SECRET_IN_PROMPT');
    expect((err as Error).message).not.toContain(SECRET);
  });

  it('hard-stops when a secret is sent for embedding', async () => {
    const r = await router();
    const e = await r.embeddings();
    await expect(e.embedDocuments(['ok', `x ${SECRET}`])).rejects.toBeInstanceOf(HardStopError);
    expect(await e.embedQuery('Account')).toHaveLength(64);
    expect(r.embeddingModelId()).toBe('mock/mock-embed');
  });

  it('times out slow calls → TRANSIENT', async () => {
    const r = await router({
      config: mockConfig({
        roles: {
          reasoning: { provider: 'mock', model: 'a' },
          coder: { provider: 'mock', model: 'b' },
          fast: { provider: 'mock', model: 'c', timeoutMs: 30 },
          judge: { provider: 'mock', model: 'd' },
        },
      }),
      mock: { fast: { delayMs: 2_000 } },
    });
    const started = Date.now();
    const err = await r
      .get('fast')
      .invoke('slow')
      .catch((e: unknown) => e);
    expect(Date.now() - started).toBeLessThan(1_500);
    expect(classifyError(err).kind).toBe('TRANSIENT');
  });

  it('accounts tokens into the run budget and stops at the limit', async () => {
    const budget = new BudgetTracker({
      tokensUsed: 0,
      tokenLimit: 40,
      startedAt: new Date().toISOString(),
      timeLimitMin: 10,
    });
    const r = await router({ budget: () => budget });
    await r.get('coder').invoke('a short prompt');
    const used = budget.snapshot().tokensUsed;
    expect(used).toBeGreaterThan(0);
    expect(r.totalTokens()).toBe(used);
    expect(r.usage[0]).toMatchObject({ role: 'coder', estimated: false });
    const err = await r
      .get('coder')
      .invoke('x'.repeat(400))
      .catch((e: unknown) => e);
    expect(classifyError(err).kind).toBe('BUDGET');
  });

  it('enforces per-provider quotas by waiting', async () => {
    let now = 0;
    const sleeps: number[] = [];
    const limiter = new RateLimiter(
      2,
      () => now,
      (ms) => {
        sleeps.push(ms);
        now += ms;
        return Promise.resolve();
      },
    );
    await limiter.acquire();
    await limiter.acquire();
    await limiter.acquire();
    expect(sleeps).toHaveLength(1);
    expect(sleeps[0]).toBeGreaterThanOrEqual(60_000);
  });

  it('router uses the configured quota for a provider', async () => {
    let now = 0;
    let waited = 0;
    const r = await router({
      config: mockConfig({ quotas: { mock: { requestsPerMinute: 1 } } }),
      limiterClock: () => now,
      limiterSleep: (ms) => {
        waited += ms;
        now += ms;
        return Promise.resolve();
      },
    });
    await r.get('coder').invoke('1');
    await r.get('fast').invoke('2'); // same provider → shares the limiter
    expect(waited).toBeGreaterThanOrEqual(60_000);
  });
});

describe('suggestGeminiModels', () => {
  it('prefers newest stable pro/flash/flash-lite and an embedding model', () => {
    const gen = ['generateContent'];
    const s = suggestGeminiModels([
      { id: 'gemini-2.5-pro', methods: gen },
      { id: 'gemini-3-pro-preview', methods: gen },
      { id: 'gemini-3.1-pro', methods: gen },
      { id: 'gemini-2.5-flash', methods: gen },
      { id: 'gemini-3-flash', methods: gen },
      { id: 'gemini-3-flash-lite', methods: gen },
      { id: 'gemini-embedding-001', methods: ['embedContent'] },
      { id: 'text-embedding-004', methods: ['embedContent'] },
    ]);
    expect(s).toEqual({
      reasoning: 'gemini-3.1-pro',
      judge: 'gemini-3.1-pro',
      coder: 'gemini-3-flash',
      fast: 'gemini-3-flash-lite',
      embeddings: 'gemini-embedding-001',
    });
  });
});

describe('suggestGeminiModels — previews', () => {
  it('keeps the stable pick but reports a newer preview of the same family', () => {
    const gen = ['generateContent'];
    const s = suggestGeminiModels([
      { id: 'gemini-2.5-pro', methods: gen },
      { id: 'gemini-3.1-pro-preview', methods: gen },
      { id: 'gemini-3.1-pro-preview-customtools', methods: gen },
      { id: 'gemini-2.5-pro-preview-tts', methods: gen },
      { id: 'gemini-3.8-flash', methods: gen },
      { id: 'gemini-3-flash-preview', methods: gen },
      { id: 'gemini-3.5-flash-lite', methods: gen },
      { id: 'gemini-3.8-flash-lite-tts', methods: gen },
    ]);
    expect(s.reasoning).toBe('gemini-2.5-pro');
    expect(s.coder).toBe('gemini-3.8-flash');
    expect(s.fast).toBe('gemini-3.5-flash-lite');
    expect(s.newerPreview).toEqual({ pro: 'gemini-3.1-pro-preview' });
  });
});
