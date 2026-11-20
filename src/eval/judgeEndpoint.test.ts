import { describe, expect, it } from 'vitest';
import { ModelsConfig } from '../config/schemas.js';
import type { EnvKey } from '../config/env.js';
import { judgeSidecarEnv, resolveJudgeChain } from './judgeEndpoint.js';

const NVIDIA_KEY = 'nvapi-secret-value-123456';
const GOOGLE_KEY = 'AIzaSy-secret-value-123456';

function config(judge: Record<string, unknown>): ModelsConfig {
  return ModelsConfig.parse({
    roles: {
      reasoning: { provider: 'mock', model: 'r' },
      coder: { provider: 'mock', model: 'c' },
      fast: { provider: 'mock', model: 'f' },
      judge,
    },
    embeddings: { provider: 'mock', model: 'e' },
    budgets: { tokensPerRun: 1000, minutesPerRun: 1 },
    quotas: { 'nvidia-nim': { requestsPerMinute: 35 }, google: { requestsPerMinute: 15 } },
  });
}

describe('DeepEval judge endpoint', () => {
  it('maps the judge chain to OpenAI-compatible endpoints (NIM direct, Gemini via its OpenAI endpoint)', () => {
    const j = resolveJudgeChain(
      config({
        provider: 'nvidia-nim',
        model: 'qwen/qwen3-235b-a22b',
        fallback: [
          { provider: 'anthropic', model: 'claude-x' },
          { provider: 'google', model: 'gemini-3.1-pro-preview' },
        ],
      }),
    );
    expect(j.chain).toEqual([
      {
        provider: 'nvidia-nim',
        baseURL: 'https://integrate.api.nvidia.com/v1',
        model: 'qwen/qwen3-235b-a22b',
        apiKeyEnv: 'NVIDIA_API_KEY',
        requestsPerMinute: 35,
      },
      {
        provider: 'google',
        baseURL: 'https://generativelanguage.googleapis.com/v1beta/openai',
        model: 'gemini-3.1-pro-preview',
        apiKeyEnv: 'GOOGLE_API_KEY',
        requestsPerMinute: 15,
      },
    ]);
    expect(j.skipped.map((s) => `${s.provider}/${s.model}`)).toEqual(['anthropic/claude-x']);
    expect(j.skipped[0]?.reason).toMatch(/no OpenAI-compatible endpoint/);
  });

  it('skips placeholders', () => {
    const j = resolveJudgeChain(
      config({ provider: 'nvidia-nim', model: '<nim-judge-model-id>', fallback: { provider: 'google', model: 'g' } }),
    );
    expect(j.chain.map((e) => e.model)).toEqual(['g']);
    expect(j.skipped[0]?.reason).toBe('placeholder model id');
  });

  it('puts keys only in their own env vars, never in QA_JUDGE_CHAIN; drops entries without a key', async () => {
    const j = resolveJudgeChain(
      config({
        provider: 'nvidia-nim',
        model: 'qwen/qwen3-235b-a22b',
        fallback: [
          { provider: 'groq', model: 'openai/gpt-oss-120b' },
          { provider: 'google', model: 'gemini-x' },
        ],
      }),
    );
    const keys: Partial<Record<EnvKey, string>> = { NVIDIA_API_KEY: NVIDIA_KEY, GOOGLE_API_KEY: GOOGLE_KEY };
    const out = await judgeSidecarEnv(j, { get: (k) => Promise.resolve(keys[k]), setting: () => undefined });
    expect(out.env['NVIDIA_API_KEY']).toBe(NVIDIA_KEY);
    expect(out.env['GOOGLE_API_KEY']).toBe(GOOGLE_KEY);
    const chainJson = out.env['QA_JUDGE_CHAIN'] ?? '';
    expect(chainJson).not.toContain(NVIDIA_KEY);
    expect(chainJson).not.toContain(GOOGLE_KEY);
    expect((JSON.parse(chainJson) as { model: string }[]).map((e) => e.model)).toEqual([
      'qwen/qwen3-235b-a22b',
      'gemini-x',
    ]);
    expect(out.env['DEEPEVAL_TELEMETRY_OPT_OUT']).toBe('YES');
    expect(out.missing).toEqual(['groq/openai/gpt-oss-120b: GROQ_API_KEY is not set']);
  });
});
