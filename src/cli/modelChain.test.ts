import { describe, expect, it } from 'vitest';
import { ModelsConfig } from '../config/schemas.js';
import { applyRoleChains, parseModelChain } from './analyze.js';

const config = ModelsConfig.parse({
  roles: {
    reasoning: { provider: 'mock', model: 'r' },
    coder: { provider: 'nvidia-nim', model: 'poolside/laguna-xs-2.1', fallback: [{ provider: 'google', model: 'g' }] },
    fast: { provider: 'mock', model: 'f' },
    judge: { provider: 'nvidia-nim', model: 'minimaxai/minimax-m3.1-flash' },
  },
  embeddings: { provider: 'mock', model: 'e' },
  budgets: { tokensPerRun: 1000, minutesPerRun: 1 },
});

describe('qa build --coder (diagnostics: one coder chain for a run, no other fallback)', () => {
  it('parses provider/model ids with slashes and :json / :no-tools flags', () => {
    expect(parseModelChain('nvidia-nim/poolside/laguna-xs-2.1:json, groq/openai/gpt-oss-120b:no-tools')).toEqual([
      { provider: 'nvidia-nim', model: 'poolside/laguna-xs-2.1', responseFormat: 'json_object' },
      { provider: 'groq', model: 'openai/gpt-oss-120b', tools: false },
    ]);
    expect(() => parseModelChain('laguna')).toThrow(/provider/);
  });

  it('replaces the chain exactly (no configured fallback left) and refuses the judge model as coder', () => {
    const c = applyRoleChains(config, { coder: parseModelChain('groq/openai/gpt-oss-120b') });
    expect(c.roles.coder).toMatchObject({ provider: 'groq', model: 'openai/gpt-oss-120b', fallbacks: [] });
    expect(c.roles.coder.responseFormat).toBeUndefined();
    expect(() =>
      applyRoleChains(config, { coder: parseModelChain('nvidia-nim/minimaxai/minimax-m3.1-flash') }),
    ).toThrow(/judge model/);
  });
});

describe('JSON mode replaces tool calling', () => {
  it('a model with responseFormat gets no load_skill tool (skills are inlined instead)', async () => {
    const { ModelRouter } = await import('../models/router.js');
    const router = await ModelRouter.create({
      config: ModelsConfig.parse({
        roles: {
          reasoning: { provider: 'mock', model: 'r' },
          coder: {
            provider: 'mock',
            model: 'c',
            responseFormat: 'json_object',
            fallback: { provider: 'mock', model: 'c2' },
          },
          fast: { provider: 'mock', model: 'f' },
          judge: { provider: 'mock', model: 'j' },
        },
        embeddings: { provider: 'mock', model: 'e' },
        budgets: { tokensPerRun: 1000, minutesPerRun: 1 },
      }),
      secrets: { get: () => Promise.resolve(undefined), setting: () => undefined },
      secretValues: () => [],
    });
    expect(router.chain('coder').map((c) => c.model.supportsTools)).toEqual([false, true]);
  });
});
