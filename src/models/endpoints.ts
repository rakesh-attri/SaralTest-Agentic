import { QAError } from '../core/errors.js';
import type { EnvKey } from '../config/env.js';
import { baseUrlProblem, type ModelsConfig, type OpenAICompatibleProvider } from '../config/schemas.js';

export interface ResolvedEndpoint {
  baseURL: string;
  apiKeyEnv: EnvKey;
}

/** Built-in presets of the `openai-compatible` provider (operator decision 2026-11-20). */
export const OPENAI_COMPATIBLE_PRESETS: Record<
  Exclude<OpenAICompatibleProvider, 'openai-compatible'>,
  ResolvedEndpoint
> = {
  'nvidia-nim': { baseURL: 'https://integrate.api.nvidia.com/v1', apiKeyEnv: 'NVIDIA_API_KEY' },
  groq: { baseURL: 'https://api.groq.com/openai/v1', apiKeyEnv: 'GROQ_API_KEY' },
};

/** Gemini's OpenAI-compatible endpoint (used to give the DeepEval judge chain one protocol). */
export const GEMINI_OPENAI_BASE_URL = 'https://generativelanguage.googleapis.com/v1beta/openai/';

/**
 * Base URL + key name for an OpenAI-compatible provider: `endpoints:` in models.yaml overrides the preset; the generic
 * `openai-compatible` provider falls back to OPENAI_COMPATIBLE_BASE_URL / OPENAI_COMPATIBLE_API_KEY. The URL is
 * checked again here because the env value bypasses the config schema.
 */
export function resolveEndpoint(
  provider: OpenAICompatibleProvider,
  endpoints: ModelsConfig['endpoints'],
  setting: (k: EnvKey) => string | undefined = () => undefined,
): ResolvedEndpoint {
  const override = endpoints?.[provider];
  const preset = provider === 'openai-compatible' ? undefined : OPENAI_COMPATIBLE_PRESETS[provider];
  const baseURL =
    override?.baseURL ??
    preset?.baseURL ??
    (provider === 'openai-compatible' ? setting('OPENAI_COMPATIBLE_BASE_URL') : undefined);
  if (!baseURL) {
    throw new QAError(
      'TOOL_UNAVAILABLE',
      `${provider}: no base URL (set endpoints.${provider}.baseURL in config/models.yaml or OPENAI_COMPATIBLE_BASE_URL)`,
    );
  }
  const problem = baseUrlProblem(baseURL);
  if (problem) throw new QAError('TOOL_UNAVAILABLE', `${provider}: ${problem}`);
  const apiKeyEnv = (override?.apiKeyEnv as EnvKey | undefined) ?? preset?.apiKeyEnv ?? 'OPENAI_COMPATIBLE_API_KEY';
  return { baseURL: baseURL.replace(/\/+$/, ''), apiKeyEnv };
}
