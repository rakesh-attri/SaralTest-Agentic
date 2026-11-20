/**
 * The ONLY place provider SDKs are imported (CLAUDE.md rule 8; enforced by ESLint `no-restricted-imports`).
 * Modules are loaded lazily so an unused provider never needs its package, keys or network.
 */
import type { Embeddings } from '@langchain/core/embeddings';
import type { BaseChatModel } from '@langchain/core/language_models/chat_models';
import { QAError } from '../../core/errors.js';
import type { ChatProvider, EmbeddingProvider, ModelsConfig } from '../../config/schemas.js';
import type { EnvKey } from '../../config/env.js';
import { resolveEndpoint } from '../endpoints.js';
import { MockChatModel, MockEmbeddings, type MockOptions } from '../mock.js';

export interface ProviderSecrets {
  get(key: EnvKey): Promise<string | undefined>;
  /** Non-secret settings (endpoints, base URLs). */
  setting(key: EnvKey): string | undefined;
}

export interface ChatModelSpec {
  provider: ChatProvider;
  model: string;
  temperature: number;
  maxOutputTokens?: number | undefined;
  mock?: MockOptions;
  /** models.yaml `endpoints:` overrides for OpenAI-compatible providers. */
  endpoints?: ModelsConfig['endpoints'];
}

/** Which secret each provider needs (doctor uses this too). */
export const PROVIDER_KEY: Record<ChatProvider, EnvKey | undefined> = {
  google: 'GOOGLE_API_KEY',
  anthropic: 'ANTHROPIC_API_KEY',
  openai: 'OPENAI_API_KEY',
  'azure-openai': 'AZURE_OPENAI_API_KEY',
  'nvidia-nim': 'NVIDIA_API_KEY',
  groq: 'GROQ_API_KEY',
  'openai-compatible': 'OPENAI_COMPATIBLE_API_KEY', // default; endpoints.openai-compatible.apiKeyEnv may override
  ollama: undefined,
  mock: undefined,
};

async function requireKey(secrets: ProviderSecrets, key: EnvKey, provider: string): Promise<string> {
  const v = await secrets.get(key);
  if (!v) {
    throw new QAError('TOOL_UNAVAILABLE', `${provider}: ${key} is not set (Windows Credential Manager or .env)`, {
      missingKey: key,
    });
  }
  return v;
}

export async function createChatModel(spec: ChatModelSpec, secrets: ProviderSecrets): Promise<BaseChatModel> {
  const common = { temperature: spec.temperature, maxRetries: 0 }; // retries are owned by policy.yaml
  switch (spec.provider) {
    case 'google': {
      const { ChatGoogleGenerativeAI } = await import('@langchain/google-genai');
      return new ChatGoogleGenerativeAI({
        ...common,
        model: spec.model,
        apiKey: await requireKey(secrets, 'GOOGLE_API_KEY', 'google'),
        ...(spec.maxOutputTokens ? { maxOutputTokens: spec.maxOutputTokens } : {}),
      });
    }
    case 'anthropic': {
      const { ChatAnthropic } = await import('@langchain/anthropic');
      return new ChatAnthropic({
        ...common,
        model: spec.model,
        apiKey: await requireKey(secrets, 'ANTHROPIC_API_KEY', 'anthropic'),
        ...(spec.maxOutputTokens ? { maxTokens: spec.maxOutputTokens } : {}),
      });
    }
    case 'openai': {
      const { ChatOpenAI } = await import('@langchain/openai');
      return new ChatOpenAI({
        ...common,
        model: spec.model,
        apiKey: await requireKey(secrets, 'OPENAI_API_KEY', 'openai'),
        ...(spec.maxOutputTokens ? { maxTokens: spec.maxOutputTokens } : {}),
      });
    }
    case 'azure-openai': {
      const { AzureChatOpenAI } = await import('@langchain/openai');
      const endpoint = secrets.setting('AZURE_OPENAI_ENDPOINT');
      if (!endpoint) throw new QAError('TOOL_UNAVAILABLE', 'azure-openai: AZURE_OPENAI_ENDPOINT is not set');
      return new AzureChatOpenAI({
        ...common,
        azureOpenAIApiKey: await requireKey(secrets, 'AZURE_OPENAI_API_KEY', 'azure-openai'),
        azureOpenAIEndpoint: endpoint,
        azureOpenAIApiDeploymentName: spec.model,
        azureOpenAIApiVersion: secrets.setting('AZURE_OPENAI_API_VERSION') ?? '2024-10-21',
      });
    }
    case 'ollama': {
      const { ChatOllama } = await import('@langchain/ollama');
      return new ChatOllama({
        model: spec.model,
        temperature: spec.temperature,
        baseUrl: secrets.setting('OLLAMA_BASE_URL') ?? 'http://localhost:11434',
      });
    }
    case 'openai-compatible':
    case 'nvidia-nim':
    case 'groq': {
      // Chat Completions only (never the Responses API): that is the protocol these endpoints implement.
      const ep = resolveEndpoint(spec.provider, spec.endpoints, (k) => secrets.setting(k));
      const { ChatOpenAICompletions } = await import('@langchain/openai');
      return new ChatOpenAICompletions({
        ...common,
        model: spec.model,
        apiKey: await requireKey(secrets, ep.apiKeyEnv, spec.provider),
        configuration: { baseURL: ep.baseURL },
        ...(spec.maxOutputTokens ? { maxTokens: spec.maxOutputTokens } : {}),
      });
    }
    case 'mock':
      return new MockChatModel({ model: spec.model, ...spec.mock });
  }
}

export async function createEmbeddings(
  spec: { provider: EmbeddingProvider; model: string },
  secrets: ProviderSecrets,
): Promise<Embeddings> {
  switch (spec.provider) {
    case 'google': {
      const { GoogleGenerativeAIEmbeddings } = await import('@langchain/google-genai');
      return new GoogleGenerativeAIEmbeddings({
        model: spec.model,
        apiKey: await requireKey(secrets, 'GOOGLE_API_KEY', 'google embeddings'),
        maxRetries: 0,
      });
    }
    case 'openai': {
      const { OpenAIEmbeddings } = await import('@langchain/openai');
      return new OpenAIEmbeddings({
        model: spec.model,
        apiKey: await requireKey(secrets, 'OPENAI_API_KEY', 'openai embeddings'),
        maxRetries: 0,
      });
    }
    case 'ollama': {
      const { OllamaEmbeddings } = await import('@langchain/ollama');
      return new OllamaEmbeddings({
        model: spec.model,
        baseUrl: secrets.setting('OLLAMA_BASE_URL') ?? 'http://localhost:11434',
      });
    }
    case 'voyage':
      throw new QAError('TOOL_UNAVAILABLE', 'voyage embeddings are not implemented yet (planned with RAG, Phase 2)');
    case 'mock':
      return new MockEmbeddings();
  }
}
