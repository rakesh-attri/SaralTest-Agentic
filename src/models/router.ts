import type { BaseLanguageModelInput } from '@langchain/core/language_models/base';
import type { BaseChatModel } from '@langchain/core/language_models/chat_models';
import type { AIMessageChunk } from '@langchain/core/messages';
import { RunnableLambda, type Runnable } from '@langchain/core/runnables';
import type { BudgetTracker } from '../core/budget.js';
import { classifyError } from '../core/classifyError.js';
import { QAError } from '../core/errors.js';
import type { Logger } from '../core/logger.js';
import { MODEL_ROLES, type ChatProvider, type ModelRole, type ModelsConfig } from '../config/schemas.js';
import { GuardedChatModel, GuardedEmbeddings, type GuardOptions } from './guarded.js';
import type { MockOptions } from './mock.js';
import { createChatModel, createEmbeddings, type ProviderSecrets } from './providers/index.js';
import { RateLimiter } from './rateLimiter.js';

/** Default requests/minute per provider when models.yaml has no `quotas` entry. */
const DEFAULT_RPM: Record<ChatProvider, number> = {
  google: 30,
  anthropic: 30,
  openai: 30,
  'azure-openai': 30,
  ollama: 120,
  mock: 100_000,
};

const isPlaceholder = (s: string): boolean => /<[^<>]+>/.test(s);

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
  /** Budget of the active run, if any. */
  budget?: () => BudgetTracker | undefined;
  logger?: Logger;
  /** Scripting for the `mock` provider (tests, offline fixture runs). */
  mock?: Partial<Record<ModelRole | `${ModelRole}:fallback`, MockOptions>>;
  limiterClock?: () => number;
  limiterSleep?: (ms: number) => Promise<void>;
}

type Slot = { model: GuardedChatModel; error?: undefined } | { model?: undefined; error: QAError };

export interface RoleStatus {
  role: ModelRole;
  provider: ChatProvider;
  model: string;
  ok: boolean;
  error?: string;
  fallback?: { provider: ChatProvider; model: string; ok: boolean; error?: string };
}

/**
 * The single entry point to language models (CLAUDE.md rule 8). Agents ask for a role, never a provider.
 * Construction never throws for a misconfigured role: the error is kept and raised as a TOOL_UNAVAILABLE Issue when
 * that role is first used, so unrelated work keeps running.
 */
export class ModelRouter {
  private readonly primary = new Map<ModelRole, Slot>();
  private readonly fallback = new Map<ModelRole, Slot>();
  private embeddingsSlot: { value: GuardedEmbeddings } | { error: QAError } | undefined;
  private readonly limiters = new Map<ChatProvider, RateLimiter>();
  readonly usage: UsageRecord[] = [];

  private constructor(private readonly opts: RouterOptions) {}

  static async create(opts: RouterOptions): Promise<ModelRouter> {
    const r = new ModelRouter(opts);
    await Promise.all(
      MODEL_ROLES.map(async (role) => {
        const cfg = opts.config.roles[role];
        r.primary.set(role, await r.build(role, cfg.provider, cfg.model, role));
        if (cfg.fallback)
          r.fallback.set(role, await r.build(role, cfg.fallback.provider, cfg.fallback.model, `${role}:fallback`));
      }),
    );
    return r;
  }

  private limiter(provider: ChatProvider): RateLimiter {
    let l = this.limiters.get(provider);
    if (!l) {
      const rpm = this.opts.config.quotas?.[provider]?.requestsPerMinute ?? DEFAULT_RPM[provider];
      l = new RateLimiter(rpm, this.opts.limiterClock, this.opts.limiterSleep);
      this.limiters.set(provider, l);
    }
    return l;
  }

  private async build(
    role: ModelRole,
    provider: ChatProvider,
    model: string,
    mockKey: ModelRole | `${ModelRole}:fallback`,
  ): Promise<Slot> {
    if (isPlaceholder(model)) {
      return {
        error: new QAError('TOOL_UNAVAILABLE', `models.yaml: role "${role}" model is still a placeholder (${model})`, {
          role,
          unconfigured: true,
        }),
      };
    }
    const cfg = this.opts.config.roles[role];
    try {
      const inner = await createChatModel(
        {
          provider,
          model,
          temperature: cfg.temperature,
          maxOutputTokens: cfg.maxOutputTokens,
          ...(this.opts.mock?.[mockKey] ? { mock: this.opts.mock[mockKey] } : {}),
        },
        this.opts.secrets,
      );
      const guard: GuardOptions = {
        role,
        provider,
        model,
        timeoutMs: cfg.timeoutMs,
        secrets: this.opts.secretValues,
        limiter: this.limiter(provider),
        ...(this.opts.budget ? { budget: this.opts.budget } : {}),
        onUsage: (u) => this.usage.push(u),
      };
      return { model: new GuardedChatModel(inner, guard) };
    } catch (err) {
      const c = classifyError(err);
      return { error: err instanceof QAError ? err : new QAError(c.kind, c.message, { role, provider }) };
    }
  }

  /** The chat model for a role (guarded: secret check, quota, timeout, token accounting). */
  get(role: ModelRole): BaseChatModel {
    const slot = this.primary.get(role);
    if (!slot) throw new QAError('TOOL_UNAVAILABLE', `no model configured for role ${role}`);
    if (slot.error) throw slot.error;
    return slot.model;
  }

  /**
   * Primary model with the configured fallback model (PLAN.md §5: INVALID_LLM_OUTPUT/TRANSIENT → fallback model).
   * `build` lets callers add structured output or tools identically to both, e.g.
   * `router.withFallback('reasoning', (m) => m.withStructuredOutput(schema))`.
   * HARD_STOP and BUDGET never fall back.
   */
  withFallback<O = AIMessageChunk>(
    role: ModelRole,
    build: (m: BaseChatModel) => Runnable<BaseLanguageModelInput, O> = (m) =>
      m as unknown as Runnable<BaseLanguageModelInput, O>,
  ): Runnable<BaseLanguageModelInput, O> {
    const primarySlot = this.primary.get(role);
    const fallbackSlot = this.fallback.get(role);
    const fb = fallbackSlot?.model ? build(fallbackSlot.model) : undefined;
    if (!primarySlot?.model) {
      if (fb) return fb; // primary misconfigured → straight to fallback (degraded, logged)
      return build(this.get(role)); // throws the stored error
    }
    const primary = build(primarySlot.model);
    if (!fb) return primary;
    return RunnableLambda.from(async (input: BaseLanguageModelInput, config): Promise<O> => {
      try {
        return await primary.invoke(input, config);
      } catch (err) {
        const kind = classifyError(err).kind;
        if (kind === 'HARD_STOP' || kind === 'BUDGET') throw err;
        this.opts.logger?.warn({ role, kind }, `primary ${role} model failed (${kind}); using fallback model`);
        return fb.invoke(input, config);
      }
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
      const cfg = this.opts.config.roles[role];
      const p = this.primary.get(role);
      const f = this.fallback.get(role);
      return {
        role,
        provider: cfg.provider,
        model: cfg.model,
        ok: !p?.error,
        ...(p?.error ? { error: p.error.message } : {}),
        ...(cfg.fallback && f
          ? {
              fallback: {
                ...cfg.fallback,
                ok: !f.error,
                ...(f.error ? { error: f.error.message } : {}),
              },
            }
          : {}),
      };
    });
  }

  totalTokens(): number {
    return this.usage.reduce((n, u) => n + u.tokens, 0);
  }
}
