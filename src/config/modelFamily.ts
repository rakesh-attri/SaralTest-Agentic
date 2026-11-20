/**
 * Coarse model family from a model id, used to keep the judge independent of the coder (CLAUDE.md rule 8, operator
 * decision 2026-11-20: judge and coder primaries from different families). Base-architecture keywords are checked
 * before vendor names, so e.g. `deepseek-r1-distill-qwen-32b` is `qwen` and `llama-3.3-nemotron-super` is `llama`.
 * Returns undefined when the family is not recognised (doctor warns instead of failing the config).
 */
const FAMILIES: readonly (readonly [RegExp, string])[] = [
  [/llama/i, 'llama'],
  [/qwen|qwq/i, 'qwen'],
  [/gpt-oss/i, 'gpt-oss'],
  [/nemotron/i, 'nemotron'],
  [/deepseek/i, 'deepseek'],
  [/mistral|mixtral|codestral|devstral|magistral|ministral/i, 'mistral'],
  [/gemma/i, 'gemma'],
  [/gemini/i, 'gemini'],
  [/kimi|moonshot/i, 'kimi'],
  [/glm/i, 'glm'],
  [/(^|\/)phi-?\d/i, 'phi'],
  [/granite/i, 'granite'],
  [/minimax/i, 'minimax'],
  [/claude/i, 'claude'],
  [/(^|\/)(gpt-|o\d)/i, 'gpt'],
];

export function modelFamily(modelId: string): string | undefined {
  return FAMILIES.find(([re]) => re.test(modelId))?.[1];
}
