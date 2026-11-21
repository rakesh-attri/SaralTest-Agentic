import { HumanMessage, type BaseMessage } from '@langchain/core/messages';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { REPO_ROOT } from '../../tests/helpers/tempProject.js';
import { extractJson, runStructured } from '../agents/shared/structured.js';
import { ModelsConfig, type ModelsConfigInput } from '../config/schemas.js';
import { modelFamily } from '../config/modelFamily.js';
import type { EnvKey } from '../config/env.js';
import { classifyError } from '../core/classifyError.js';
import { HardStopError, QAError } from '../core/errors.js';
import { SkillLoader } from '../skills/skillLoader.js';
import { resolveEndpoint } from './endpoints.js';
import { GuardedChatModel, retryAfterMs } from './guarded.js';
import { MockChatModel, MOCK_DEFAULT_RESPONSE, type MockOptions } from './mock.js';
import type { ProviderSecrets } from './providers/index.js';
import { isRateLimited, rateLimitedError, RateLimiter } from './rateLimiter.js';
import { ModelRouter, type MockKey } from './router.js';

const SECRET = 'AIzaSy-test-secret-value-123';
const secrets = (values: Partial<Record<EnvKey, string>> = {}): ProviderSecrets => ({
  get: (k) => Promise.resolve(values[k]),
  setting: (k) => values[k],
});

function config(over: Partial<ModelsConfigInput> = {}): ModelsConfig {
  return ModelsConfig.parse({
    roles: {
      reasoning: { provider: 'mock', model: 'mock-pro' },
      coder: {
        provider: 'mock',
        model: 'mock-nim-coder',
        fallback: [
          { provider: 'mock', model: 'mock-groq-coder' },
          { provider: 'mock', model: 'mock-gemini-flash' },
        ],
      },
      fast: { provider: 'mock', model: 'mock-lite' },
      judge: { provider: 'mock', model: 'mock-judge', fallback: { provider: 'mock', model: 'mock-gemini-pro' } },
    },
    embeddings: { provider: 'mock', model: 'mock-embed' },
    budgets: { tokensPerRun: 1_000_000, minutesPerRun: 10 },
    ...over,
  });
}

const router = (mock: Partial<Record<MockKey, MockOptions>> = {}, cfg = config()): Promise<ModelRouter> =>
  ModelRouter.create({ config: cfg, secrets: secrets(), secretValues: () => [SECRET], mock });

const http429 = (): Error =>
  Object.assign(new Error('429 Too Many Requests'), { status: 429, headers: { 'retry-after': '7' } });

describe('models.yaml — providers, presets and chains', () => {
  it('normalizes one fallback or a list into an ordered chain', () => {
    const c = config();
    expect(c.roles.coder.fallbacks.map((f) => f.model)).toEqual(['mock-groq-coder', 'mock-gemini-flash']);
    expect(c.roles.judge.fallbacks).toHaveLength(1);
    expect(c.roles.fast.fallbacks).toEqual([]);
  });

  it('rejects a judge that shares a model with any coder chain entry (rule 8)', () => {
    expect(() =>
      config({
        roles: {
          reasoning: { provider: 'mock', model: 'a' },
          coder: { provider: 'mock', model: 'c', fallback: { provider: 'google', model: 'gemini-x' } },
          fast: { provider: 'mock', model: 'b' },
          judge: { provider: 'mock', model: 'j', fallback: { provider: 'google', model: 'gemini-x' } },
        },
      }),
    ).toThrow(/judge must use a different model than coder.*google\/gemini-x/);
  });

  it('endpoint overrides must be https (or localhost) and name a known secret key', () => {
    expect(() => config({ endpoints: { 'nvidia-nim': { baseURL: 'http://nim.example.com/v1' } } })).toThrow(/https/);
    expect(() => config({ endpoints: { 'nvidia-nim': { baseURL: 'http://localhost:8000/v1' } } })).not.toThrow();
    expect(() => config({ endpoints: { groq: { apiKeyEnv: 'JIRA_EMAIL' } } })).toThrow(/not a known secret key/);
  });

  it('resolves the NVIDIA NIM and Groq presets, overrides, and the generic provider', () => {
    expect(resolveEndpoint('nvidia-nim', undefined)).toEqual({
      baseURL: 'https://integrate.api.nvidia.com/v1',
      apiKeyEnv: 'NVIDIA_API_KEY',
    });
    expect(resolveEndpoint('groq', undefined)).toEqual({
      baseURL: 'https://api.groq.com/openai/v1',
      apiKeyEnv: 'GROQ_API_KEY',
    });
    expect(resolveEndpoint('nvidia-nim', { 'nvidia-nim': { baseURL: 'http://localhost:8000/v1/' } }).baseURL).toBe(
      'http://localhost:8000/v1',
    );
    expect(() => resolveEndpoint('openai-compatible', undefined)).toThrow(/no base URL/);
    const env = (k: EnvKey): string | undefined =>
      k === 'OPENAI_COMPATIBLE_BASE_URL' ? 'http://evil.example.com/v1' : undefined;
    expect(() => resolveEndpoint('openai-compatible', undefined, env)).toThrow(/https/);
  });

  it('builds an OpenAI-compatible chat-completions model for nvidia-nim / groq (no call made)', async () => {
    const r = await ModelRouter.create({
      config: config({
        roles: {
          reasoning: { provider: 'nvidia-nim', model: 'meta/llama-3.3-70b-instruct' },
          coder: { provider: 'mock', model: 'm1' },
          fast: { provider: 'groq', model: 'llama-3.1-8b-instant' },
          judge: { provider: 'mock', model: 'm3' },
        },
      }),
      secrets: secrets({ NVIDIA_API_KEY: 'nvapi-fake-123456', GROQ_API_KEY: 'gsk-fake-123456' }),
      secretValues: () => [],
    });
    const nim = r.chain('reasoning')[0]!.model;
    expect(nim._llmType()).toBe('guarded:openai');
    const kwargs = (nim.inner as unknown as { lc_kwargs: { configuration?: { baseURL?: string } } }).lc_kwargs;
    expect(kwargs.configuration?.baseURL).toBe('https://integrate.api.nvidia.com/v1');
    const groq = r.chain('fast')[0]!.model;
    expect(
      (groq.inner as unknown as { lc_kwargs: { configuration?: { baseURL?: string } } }).lc_kwargs.configuration
        ?.baseURL,
    ).toBe('https://api.groq.com/openai/v1');
  });

  it('a missing NVIDIA key leaves the primary unusable and the chain starts at the fallback', async () => {
    const r = await ModelRouter.create({
      config: config({
        roles: {
          reasoning: {
            provider: 'nvidia-nim',
            model: 'meta/llama-3.3-70b-instruct',
            fallback: { provider: 'mock', model: 'gemini-standin' },
          },
          coder: { provider: 'mock', model: 'm1' },
          fast: { provider: 'mock', model: 'm2' },
          judge: { provider: 'mock', model: 'm3' },
        },
      }),
      secrets: secrets(),
      secretValues: () => [],
    });
    expect(r.status().find((s) => s.role === 'reasoning')?.error).toMatch(/NVIDIA_API_KEY is not set/);
    expect(r.chain('reasoning').map((c) => c.id)).toEqual(['mock/gemini-standin']);
  });

  it('model families', () => {
    expect(modelFamily('meta/llama-3.3-70b-instruct')).toBe('llama');
    expect(modelFamily('nvidia/llama-3.3-nemotron-super-49b-v1.5')).toBe('llama');
    expect(modelFamily('qwen/qwen3-coder-480b-a35b-instruct')).toBe('qwen');
    expect(modelFamily('deepseek-ai/deepseek-r1-distill-qwen-32b')).toBe('qwen');
    expect(modelFamily('openai/gpt-oss-120b')).toBe('gpt-oss');
    expect(modelFamily('mistralai/mixtral-8x22b-instruct-v0.1')).toBe('mistral');
    expect(modelFamily('gemini-3.5-flash-lite')).toBe('gemini');
    expect(modelFamily('poolside/laguna-xs-2.1')).toBe('poolside');
    expect(modelFamily('minimaxai/minimax-m3.1-flash')).toBe('minimax');
    expect(modelFamily('stepfun-ai/step-5-preview')).toBe('step');
    expect(modelFamily('some-unknown-model')).toBeUndefined();
  });
});

describe('ModelRouter — fallback chain', () => {
  it('lists the chain in order with honest labels', async () => {
    const r = await router();
    expect(r.chain('coder').map((c) => c.id)).toEqual([
      'mock/mock-nim-coder',
      'mock/mock-groq-coder',
      'mock/mock-gemini-flash',
    ]);
    expect(r.modelId('coder', 2)).toBe('mock/mock-gemini-flash');
    expect(r.modelId('coder', true)).toBe('mock/mock-groq-coder');
    expect(
      r
        .status()
        .find((s) => s.role === 'coder')
        ?.fallbacks.map((f) => f.model),
    ).toEqual(['mock-groq-coder', 'mock-gemini-flash']);
  });

  it('withFallback walks the whole chain: rate limited → next → next', async () => {
    const r = await router({
      coder: { failFirst: { times: 9, error: () => rateLimitedError('nvidia-nim', 'nim 429', 5_000) } },
      'coder:fallback': { failFirst: { times: 9, error: () => new Error('503 overloaded') } },
      'coder:fallback:2': { responder: () => 'from gemini' },
    });
    const out = await r.withFallback('coder').invoke('write a test');
    expect(out.content).toBe('from gemini');
  });

  it('never fails over on a hard stop', async () => {
    const r = await router();
    await expect(r.withFallback('coder').invoke(`leak ${SECRET}`)).rejects.toBeInstanceOf(HardStopError);
  });
});

describe('runStructured — chain failover', () => {
  const Out = z.object({ ok: z.boolean() });
  const base = { role: 'coder' as const, agent: 'test', schema: Out, system: 'Answer.', user: 'Go.' };

  it('429 on the primary and an error on the second → third model answers, labelled', async () => {
    const r = await router({
      coder: { failFirst: { times: 9, error: () => rateLimitedError('nvidia-nim', 'nvidia-nim rate limited', 9_000) } },
      'coder:fallback': { failFirst: { times: 9, error: () => new Error('ECONNRESET') } },
      'coder:fallback:2': { responder: () => '{"ok":true}' },
    });
    const res = await runStructured({ ...base, router: r });
    expect(res.value).toEqual({ ok: true });
    expect(res.model).toBe('mock/mock-gemini-flash');
    expect(res.usedFallback).toBe(true);
    expect(res.attempts.map((a) => `${a.model}:${a.outcome}`)).toEqual([
      'mock/mock-nim-coder:ERROR',
      'mock/mock-groq-coder:ERROR',
      'mock/mock-gemini-flash:OK',
    ]);
    expect(res.attempts[0]?.problems?.[0]).toMatch(/TRANSIENT: nvidia-nim rate limited/);
  });

  it('a model marked tools: false gets the skill bodies inline instead of load_skill', async () => {
    const seen: BaseMessage[][] = [];
    const r = await router(
      {
        coder: {
          responder: (m) => {
            seen.push(m);
            return '{"ok":true}';
          },
        },
      },
      config({
        roles: {
          reasoning: { provider: 'mock', model: 'mock-pro' },
          coder: { provider: 'mock', model: 'mock-no-tools', tools: false },
          fast: { provider: 'mock', model: 'mock-lite' },
          judge: { provider: 'mock', model: 'mock-judge' },
        },
      }),
    );
    const loader = SkillLoader.forProject(REPO_ROOT);
    const res = await runStructured({
      ...base,
      router: r,
      skills: { loader, names: ['playwright-standards'] },
    });
    expect(res.skillsLoaded).toEqual(['playwright-standards']);
    const system = seen[0]?.[0];
    expect(typeof system?.content === 'string' && system.content).toMatch(/## Skills \(full text/);
  });

  it('strips <think> blocks before reading the JSON', () => {
    expect(extractJson('<think>maybe {"no":1}</think>\n{"ok":true}')).toEqual({ ok: true });
  });
});

describe('RateLimiter — requests, tokens, cooldown', () => {
  const fakeTime = (): { now: () => number; sleep: (ms: number) => Promise<void>; slept: number[] } => {
    let t = 0;
    const slept: number[] = [];
    return {
      now: () => t,
      sleep: (ms) => {
        slept.push(ms);
        t += ms;
        return Promise.resolve();
      },
      slept,
    };
  };

  it('a request larger than the token quota fails over immediately', async () => {
    const f = fakeTime();
    const l = new RateLimiter(undefined, f.now, f.sleep, { tokensPerMinute: 100, name: 'groq' });
    const err = await l.acquire(150).catch((e: unknown) => e);
    expect(isRateLimited(err)).toBe(true);
    expect((err as Error).message).toMatch(/groq: request needs ~150 tokens, more than its 100 tokens\/minute/);
    expect(f.slept).toEqual([]);
  });

  it('waits when the wait is short, fails fast when it exceeds maxWaitMs', async () => {
    const f = fakeTime();
    const l = new RateLimiter(10, f.now, f.sleep, { tokensPerMinute: 100, maxWaitMs: 20_000, name: 'groq' });
    await l.acquire(60);
    const err = await l.acquire(60).catch((e: unknown) => e); // needs ~60 s → over maxWait
    expect(isRateLimited(err)).toBe(true);
    expect(classifyError(err).kind).toBe('TRANSIENT');
    await l.acquire(60, 61_000); // last in chain: allowed to wait the window out
    expect(f.slept).toHaveLength(1);
    expect(f.slept[0]).toBeGreaterThanOrEqual(60_000);
  });

  it('settle replaces the estimate with real usage', async () => {
    const f = fakeTime();
    const l = new RateLimiter(undefined, f.now, f.sleep, { tokensPerMinute: 100, maxWaitMs: 0 });
    const t = await l.acquire(90);
    l.settle(t, 10);
    await expect(l.acquire(80)).resolves.toBeDefined();
  });

  it('a 429 cooldown fails fast, except for the last model of a chain, which waits it out', async () => {
    const f = fakeTime();
    const l = new RateLimiter(100, f.now, f.sleep, { maxWaitMs: 20_000, name: 'nvidia-nim' });
    l.cooldown(5_000);
    const err = await l.acquire(10).catch((e: unknown) => e);
    expect((err as Error).message).toMatch(/cooling down after HTTP 429/);
    expect(f.slept).toEqual([]);
    await l.acquire(10, 61_000, true);
    expect(f.slept).toEqual([5_000]);
  });

  it('requests per minute still wait by default (ingest / embeddings behaviour)', async () => {
    const f = fakeTime();
    const l = new RateLimiter(2, f.now, f.sleep);
    await l.acquire();
    await l.acquire();
    await l.acquire();
    expect(f.slept).toHaveLength(1);
  });
});

describe('GuardedChatModel — provider 429', () => {
  it('a provider 429 cools the provider down (Retry-After) so the next call fails over without a request', async () => {
    let t = 0;
    const limiter = new RateLimiter(
      100,
      () => t,
      () => Promise.resolve(),
      { maxWaitMs: 1_000, name: 'nvidia-nim' },
    );
    const inner = new MockChatModel({ model: 'nim', failFirst: { times: 1, error: http429 } });
    const g = new GuardedChatModel(inner, {
      role: 'reasoning',
      provider: 'nvidia-nim',
      model: 'nim',
      timeoutMs: 5_000,
      secrets: () => [],
      limiter,
    });
    const first = await g.invoke([new HumanMessage('hi')]).catch((e: unknown) => e);
    expect(isRateLimited(first)).toBe(true);
    expect((first as QAError).detail).toMatchObject({ status: 429, provider: 'nvidia-nim', retryAfterMs: 7_000 });
    expect(limiter.cooldownRemaining()).toBe(7_000);

    const second = await g.invoke([new HumanMessage('hi again')]).catch((e: unknown) => e);
    expect(isRateLimited(second)).toBe(true);
    expect(inner.calls).toBe(1); // no second request reached the provider
    expect((second as Error).message).toMatch(/cooling down after HTTP 429/);

    t += 7_001;
    const third = await g.invoke([new HumanMessage('later')]);
    expect(third.content).toBe(MOCK_DEFAULT_RESPONSE);
  });

  it('an overloaded 503 is not treated as a rate limit', async () => {
    const limiter = new RateLimiter(100);
    const inner = new MockChatModel({
      failFirst: { times: 1, error: () => Object.assign(new Error('503 overloaded'), { status: 503 }) },
    });
    const g = new GuardedChatModel(inner, {
      role: 'fast',
      provider: 'groq',
      model: 'x',
      timeoutMs: 5_000,
      secrets: () => [],
      limiter,
    });
    const err = await g.invoke('x').catch((e: unknown) => e);
    expect(isRateLimited(err)).toBe(false);
    expect(limiter.cooldownRemaining()).toBe(0);
  });

  it('reads Retry-After seconds, HTTP dates, retry-after-ms and Headers objects', () => {
    expect(retryAfterMs({ headers: { 'retry-after': '2' } })).toBe(2_000);
    expect(retryAfterMs({ headers: new Headers({ 'retry-after-ms': '1500' }) })).toBe(1_500);
    expect(retryAfterMs({ headers: { 'retry-after': new Date(10_000).toUTCString() } }, 0)).toBe(10_000);
    expect(retryAfterMs({ cause: { headers: { 'retry-after': '3' } } })).toBe(3_000);
    expect(retryAfterMs(new Error('x'))).toBeUndefined();
  });

  it('rate-limited errors are TRANSIENT QAErrors (existing policy: retry, fallback, escalate)', () => {
    const e = rateLimitedError('groq', 'groq limited', 1_000);
    expect(e).toBeInstanceOf(QAError);
    expect(classifyError(e).kind).toBe('TRANSIENT');
  });
});
