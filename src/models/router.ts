import type { BaseLanguageModelInput } from '@langchain/core/language_models/base';
import type { BaseChatModel } from '@langchain/core/language_models/chat_models';
import type { AIMessageChunk } from '@langchain/core/messages';
import { RunnableLambda, type Runnable } from '@langchain/core/runnables';
import { currentBudget, type BudgetTracker } from '../core/budget.js';
import { classifyError } from '../core/classifyError.js';
import { QAError } from '../core/errors.js';
import type { Logger } from '../core/logger.js';
import {
  MODEL_ROLES,
  type ChatProvider,
  type ModelRef,
  type ModelRole,
  type ModelsConfig,
  type ProviderQuota,
} from '../config/schemas.js';
import { GuardedChatModel, GuardedEmbeddings, type GuardOptions } from './guarded.js';
import type { MockOptions } from './mock.js';
import { createChatModel, createEmbeddings, type ProviderSecrets } from './providers/index.js';
import { isRateLimited, RateLimiter } from './rateLimiter.js';

/**
 * Default per-provider quotas when models.yaml has no `quotas` entry. Conservative free-tier-sized values; the
 * operator adjusts them in models.yaml (doctor prints the effective numbers).
 */
export const DEFAULT_QUOTAS: Record<ChatProvider, ProviderQuota> = {
  google: { requestsPerMinute: 30 },
  anthropic: { requestsPerMinute: 30 },
  openai: { requestsPerMinute: 30 },
  'azure-openai': { requestsPerMinute: 30 },
  'nvidia-nim': { requestsPerMinute: 40 },
  groq: { requestsPerMinute: 30, tokensPerMinute: 6_000 },
  'openai-compatible': { requestsPerMinute: 60 },
  ollama: { requestsPerMinute: 120 },
  mock: { requestsPerMinute: 100_000 },
};
/** How long a call waits for quota before failing over to the next model in its chain. */
export const DEFAULT_MAX_WAIT_MS = 20_000;
/** The last model in a chain has nothing to fail over to: it waits up to one full quota window. */
export const LAST_IN_CHAIN_MAX_WAIT_MS = 61_000;

const isPlaceholder = (s: string): boolean => /<[^<>]+>/.test(s);

export type MockKey = ModelRole | `${ModelRole}:fallback` | `${ModelRole}:fallback:${number}`;
/** Mock scripting key for chain position `index` (0 = primary, 1 = `role:fallback`, n = `role:fallback:n`). */
export const mockKey = (role: ModelRole, index: number): MockKey =>
  index === 0 ? role : index === 1 ? `${role}:fallback` : `${role}:fallback:${index}`;

export interface UsageRecord {
  role: string;
  provider: string;
  model: string;
  tokens: number;
  estimated: boolean;
}

export interface RouterOptions {
  config: ModelsConfig;
  secrets: ProviderSecrets;
  /** Known secret values for the prompt guard (rule 4: a secret in a prompt is a hard stop). */
  secretValues: () => readonly string[];
  /** Budget of the active run, if any. Default: the run whose graph node is executing (`currentBudget`). */
  budget?: () => BudgetTracker | undefined;
  logger?: Logger;
  /** Scripting for the `mock` provider (tests, offline fixture runs). */
  mock?: Partial<Record<MockKey, MockOptions>>;
  limiterClock?: () => number;
  limiterSleep?: (ms: number) => Promise<void>;
}

type Slot = { model: GuardedChatModel; error?: undefined } | { model?: undefined; error: QAError };

interface Entry {
  index: number;
  provider: ChatProvider;
  model: string;
  slot: Slot;
}

/** A usable model of a role's chain, in order (0 = primary). */
export interface ChainModel {
  index: number;
  provider: ChatProvider;
  /** `provider/model` — the label recorded with every output. */
  id: string;
  model: GuardedChatModel;
}

export interface ModelStatus {
  provider: ChatProvider;
  model: string;
  ok: boolean;
  error?: string;
}

export interface RoleStatus extends ModelStatus {
  role: ModelRole;
  /** Fallback chain after the primary, in order. */
  fallbacks: ModelStatus[];
}

export type EffectiveQuota = ProviderQuota & { maxWaitMs: number };

/** Effective quota for a provider: models.yaml `quotas` over DEFAULT_QUOTAS (also used for the DeepEval judge). */
export function effectiveQuota(config: ModelsConfig, provider: ChatProvider): EffectiveQuota {
  const q = config.quotas?.[provider];
  const d = DEFAULT_QUOTAS[provider];
  const rpm = q?.requestsPerMinute ?? d.requestsPerMinute;
  const tpm = q?.tokensPerMinute ?? d.tokensPerMinute;
  return {
    ...(rpm !== undefined ? { requestsPerMinute: rpm } : {}),
    ...(tpm !== undefined ? { tokensPerMinute: tpm } : {}),
    maxWaitMs: q?.maxWaitMs ?? DEFAULT_MAX_WAIT_MS,
  };
}

/**
 * The single entry point to language models (CLAUDE.md rule 8). Agents ask for a role, never a provider.
 * Each role has an ordered chain: primary, then fallbacks (e.g. NVIDIA NIM → Groq → Gemini). Rate limits are per
 * provider and shared by all roles; a provider that is out of quota or answered HTTP 429 fails fast, so the chain moves
 * on to the next provider instead of stalling.
 * Construction never throws for a misconfigured model: the error is kept and raised as a TOOL_UNAVAILABLE Issue when
 * that role is first used (or the entry is skipped in the chain), so unrelated work keeps running.
 */
export class ModelRouter {
  private readonly chains = new Map<ModelRole, Entry[]>();
  private embeddingsSlot: { value: GuardedEmbeddings } | { error: QAError } | undefined;
  private readonly limiters = new Map<ChatProvider, RateLimiter>();
  readonly usage: UsageRecord[] = [];

  private constructor(private readonly opts: RouterOptions) {}

  static async create(opts: RouterOptions): Promise<ModelRouter> {
    const r = new ModelRouter(opts);
    await Promise.all(
      MODEL_ROLES.map(async (role) => {
        const cfg = opts.config.roles[role];
        const refs: ModelRef[] = [cfg, ...cfg.fallbacks];
        const entries = await Promise.all(
          refs.map(async (ref, index): Promise<Entry> => ({
            index,
            provider: ref.provider,
            model: ref.model,
            slot: await r.build(role, ref, index, index === refs.length - 1),
          })),
        );
        r.chains.set(role, entries);
      }),
    );
    return r;
  }

  /** Effective quota for a provider (models.yaml `quotas` over the defaults). */
  quota(provider: ChatProvider): EffectiveQuota {
    return effectiveQuota(this.opts.config, provider);
  }

  private limiter(provider: ChatProvider): RateLimiter {
    let l = this.limiters.get(provider);
    if (!l) {
      const q = this.quota(provider);
      l = new RateLimiter(q.requestsPerMinute, this.opts.limiterClock, this.opts.limiterSleep, {
        tokensPerMinute: q.tokensPerMinute,
        maxWaitMs: q.maxWaitMs,
        name: provider,
      });
      this.limiters.set(provider, l);
    }
    return l;
  }

  private async build(role: ModelRole, ref: ModelRef, index: number, last: boolean): Promise<Slot> {
    const { provider, model } = ref;
    if (isPlaceholder(model)) {
      return {
        error: new QAError(
          'TOOL_UNAVAILABLE',
          `models.yaml: role "${role}" ${index ? `fallback ${index}` : 'model'} is still a placeholder (${model})`,
          { role, unconfigured: true },
        ),
      };
    }
    const cfg = this.opts.config.roles[role];
    const mock = this.opts.mock?.[mockKey(role, index)];
    try {
      const inner = await createChatModel(
        {
          provider,
          model,
          temperature: cfg.temperature,
          maxOutputTokens: cfg.maxOutputTokens,
          ...(ref.responseFormat ? { responseFormat: ref.responseFormat } : {}),
          ...(this.opts.config.endpoints ? { endpoints: this.opts.config.endpoints } : {}),
          ...(mock ? { mock } : {}),
        },
        this.opts.secrets,
      );
      const limiter = this.limiter(provider);
      const guard: GuardOptions = {
        role,
        provider,
        model,
        timeoutMs: cfg.timeoutMs,
        secrets: this.opts.secretValues,
        limiter,
        maxWaitMs: last ? Math.max(limiter.maxWaitMs, LAST_IN_CHAIN_MAX_WAIT_MS) : limiter.maxWaitMs,
        lastInChain: last,
        maxOutputTokens: cfg.maxOutputTokens,
        // JSON mode replaces tool calling for the model (a load_skill call is not JSON output).
        tools: ref.tools !== false && !ref.responseFormat,
        budget: this.opts.budget ?? currentBudget,
        onUsage: (u) => this.usage.push(u),
      };
      return { model: new GuardedChatModel(inner, guard) };
    } catch (err) {
      const c = classifyError(err);
      return { error: err instanceof QAError ? err : new QAError(c.kind, c.message, { role, provider }) };
    }
  }

  private entries(role: ModelRole): Entry[] {
    return this.chains.get(role) ?? [];
  }

  /** The primary chat model for a role (guarded: secret check, quota, timeout, token accounting). */
  get(role: ModelRole): BaseChatModel {
    const slot = this.entries(role)[0]?.slot;
    if (!slot) throw new QAError('TOOL_UNAVAILABLE', `no model configured for role ${role}`);
    if (slot.error) throw slot.error;
    return slot.model;
  }

  /** The usable models of a role's chain, primary first. Misconfigured/placeholder entries are skipped. */
  chain(role: ModelRole): ChainModel[] {
    return this.entries(role).flatMap((e) =>
      e.slot.model
        ? [{ index: e.index, provider: e.provider, id: `${e.provider}/${e.model}`, model: e.slot.model }]
        : [],
    );
  }

  /** The first configured fallback model (chain position 1), or undefined when none is configured or usable. */
  getFallback(role: ModelRole): BaseChatModel | undefined {
    return this.entries(role)[1]?.slot.model;
  }

  /** `provider/model` at a chain position (true = first fallback) for labelling outputs. */
  modelId(role: ModelRole, position: boolean | number = 0): string {
    const index = position === true ? 1 : position === false ? 0 : position;
    const e = this.entries(role)[index] ?? this.entries(role)[0];
    return e ? `${e.provider}/${e.model}` : `unconfigured/${role}`;
  }

  /**
   * The role's whole chain as one runnable (PLAN.md §5: TRANSIENT / rate limit / provider error → next model).
   * `build` lets callers add structured output or tools identically to every model, e.g.
   * `router.withFallback('reasoning', (m) => m.withStructuredOutput(schema))`.
   * HARD_STOP and BUDGET never fall back.
   */
  withFallback<O = AIMessageChunk>(
    role: ModelRole,
    build: (m: BaseChatModel) => Runnable<BaseLanguageModelInput, O> = (m) =>
      m as unknown as Runnable<BaseLanguageModelInput, O>,
  ): Runnable<BaseLanguageModelInput, O> {
    const chain = this.chain(role);
    if (!chain.length) return build(this.get(role)); // throws the stored primary error
    const built = chain.map((c) => ({ id: c.id, runnable: build(c.model) }));
    if (built.length === 1 && built[0]) return built[0].runnable;
    return RunnableLambda.from(async (input: BaseLanguageModelInput, config): Promise<O> => {
      let lastErr: unknown;
      for (const [i, c] of built.entries()) {
        try {
          return await c.runnable.invoke(input, config);
        } catch (err) {
          const kind = classifyError(err).kind;
          if (kind === 'HARD_STOP' || kind === 'BUDGET') throw err;
          lastErr = err;
          const next = built[i + 1];
          if (next) {
            const why = isRateLimited(err) ? 'rate limited' : kind;
            this.opts.logger?.warn(
              { role, from: c.id, to: next.id, kind, rateLimited: isRateLimited(err) },
              `${role}: ${c.id} failed (${why}); failing over to ${next.id}`,
            );
          }
        }
      }
      throw lastErr;
    }).withConfig({ runName: `fallback:${role}` });
  }

  /** Embeddings (default Google). The model id is stored with every vector; a change requires reindexing. */
  async embeddings(): Promise<GuardedEmbeddings> {
    if (!this.embeddingsSlot) {
      const e = this.opts.config.embeddings;
      try {
        if (isPlaceholder(e.model)) {
          throw new QAError('TOOL_UNAVAILABLE', `models.yaml: embeddings model is still a placeholder (${e.model})`);
        }
        const inner = await createEmbeddings(e, this.opts.secrets);
        this.embeddingsSlot = { value: new GuardedEmbeddings(inner, this.opts.secretValues, this.embeddingModelId()) };
      } catch (err) {
        const c = classifyError(err);
        this.embeddingsSlot = { error: err instanceof QAError ? err : new QAError(c.kind, c.message) };
      }
    }
    if ('error' in this.embeddingsSlot) throw this.embeddingsSlot.error;
    return this.embeddingsSlot.value;
  }

  embeddingModelId(): string {
    const e = this.opts.config.embeddings;
    return `${e.provider}/${e.model}`;
  }

  /** True when a role answers from the mock provider → every result it influences is labelled MOCK (rule 13). */
  isMock(role: ModelRole): boolean {
    return this.opts.config.roles[role].provider === 'mock';
  }

  status(): RoleStatus[] {
    return MODEL_ROLES.map((role) => {
      const [primary, ...rest] = this.entries(role).map((e): ModelStatus => ({
        provider: e.provider,
        model: e.model,
        ok: !e.slot.error,
        ...(e.slot.error ? { error: e.slot.error.message } : {}),
      }));
      const cfg = this.opts.config.roles[role];
      return { role, ...(primary ?? { provider: cfg.provider, model: cfg.model, ok: false }), fallbacks: rest };
    });
  }

  totalTokens(): number {
    return this.usage.reduce((n, u) => n + u.tokens, 0);
  }
}
