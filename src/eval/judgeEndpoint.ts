import type { EnvKey } from '../config/env.js';
import { isOpenAICompatible, type ChatProvider, type ModelsConfig } from '../config/schemas.js';
import { GEMINI_OPENAI_BASE_URL, resolveEndpoint } from '../models/endpoints.js';
import type { ProviderSecrets } from '../models/providers/index.js';
import { effectiveQuota } from '../models/router.js';

/**
 * The DeepEval judge (PLAN.md §9) uses the same `judge` role chain as the TS agents, spoken over the OpenAI-compatible
 * protocol: NVIDIA NIM / Groq / openai-compatible endpoints directly, Gemini through its OpenAI-compatible endpoint.
 * The Python sidecar (`eval/qa_eval/judge_model.py`) reads the chain from QA_JUDGE_CHAIN and each key from its own
 * env var — keys are never written into task files, the chain JSON or logs.
 */
export interface JudgeChainEntry {
  provider: ChatProvider;
  baseURL: string;
  model: string;
  /** Env var the sidecar reads the key from (the value travels only in the child-process env). */
  apiKeyEnv?: EnvKey;
  requestsPerMinute?: number;
  tokensPerMinute?: number;
}

export interface JudgeChain {
  chain: JudgeChainEntry[];
  /** Judge chain entries the sidecar cannot use, with the reason (reported, never silently dropped). */
  skipped: { provider: ChatProvider; model: string; reason: string }[];
}

const isPlaceholder = (s: string): boolean => /<[^<>]+>/.test(s);

function endpointFor(
  provider: ChatProvider,
  config: ModelsConfig,
  setting: (k: EnvKey) => string | undefined,
): { baseURL: string; apiKeyEnv?: EnvKey } | string {
  if (isOpenAICompatible(provider)) {
    try {
      return resolveEndpoint(provider, config.endpoints, setting);
    } catch (err) {
      return err instanceof Error ? err.message : String(err);
    }
  }
  switch (provider) {
    case 'google':
      return { baseURL: GEMINI_OPENAI_BASE_URL.replace(/\/+$/, ''), apiKeyEnv: 'GOOGLE_API_KEY' };
    case 'openai':
      return { baseURL: 'https://api.openai.com/v1', apiKeyEnv: 'OPENAI_API_KEY' };
    case 'ollama':
      return { baseURL: `${(setting('OLLAMA_BASE_URL') ?? 'http://localhost:11434').replace(/\/+$/, '')}/v1` };
    default:
      return `${provider} has no OpenAI-compatible endpoint wired for the DeepEval judge`;
  }
}

/** Ordered judge chain (primary, then fallbacks) as OpenAI-compatible endpoints with their quotas. */
export function resolveJudgeChain(
  config: ModelsConfig,
  setting: (k: EnvKey) => string | undefined = () => undefined,
): JudgeChain {
  const judge = config.roles.judge;
  const out: JudgeChain = { chain: [], skipped: [] };
  for (const ref of [judge, ...judge.fallbacks]) {
    if (isPlaceholder(ref.model)) {
      out.skipped.push({ provider: ref.provider, model: ref.model, reason: 'placeholder model id' });
      continue;
    }
    const ep = endpointFor(ref.provider, config, setting);
    if (typeof ep === 'string') {
      out.skipped.push({ provider: ref.provider, model: ref.model, reason: ep });
      continue;
    }
    const q = effectiveQuota(config, ref.provider);
    out.chain.push({
      provider: ref.provider,
      baseURL: ep.baseURL,
      model: ref.model,
      ...(ep.apiKeyEnv ? { apiKeyEnv: ep.apiKeyEnv } : {}),
      ...(q.requestsPerMinute !== undefined ? { requestsPerMinute: q.requestsPerMinute } : {}),
      ...(q.tokensPerMinute !== undefined ? { tokensPerMinute: q.tokensPerMinute } : {}),
    });
  }
  return out;
}

/**
 * Environment for the DeepEval sidecar child process: QA_JUDGE_CHAIN (no secrets) plus one env var per key the chain
 * needs. Entries whose key is missing are left out of the chain and reported in `missing`.
 */
export async function judgeSidecarEnv(
  judge: JudgeChain,
  secrets: ProviderSecrets,
): Promise<{ env: Record<string, string>; chain: JudgeChainEntry[]; missing: string[] }> {
  const env: Record<string, string> = {};
  const usable: JudgeChainEntry[] = [];
  const missing: string[] = [];
  for (const e of judge.chain) {
    if (e.apiKeyEnv) {
      const key = env[e.apiKeyEnv] ?? (await secrets.get(e.apiKeyEnv));
      if (!key) {
        missing.push(`${e.provider}/${e.model}: ${e.apiKeyEnv} is not set`);
        continue;
      }
      env[e.apiKeyEnv] = key;
    }
    usable.push(e);
  }
  env['QA_JUDGE_CHAIN'] = JSON.stringify(usable);
  // Nothing about runs leaves the machine through DeepEval's own telemetry (rule 14).
  env['DEEPEVAL_TELEMETRY_OPT_OUT'] = 'YES';
  return { env, chain: usable, missing };
}
