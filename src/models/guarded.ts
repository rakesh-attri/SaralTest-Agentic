import type { CallbackManagerForLLMRun } from '@langchain/core/callbacks/manager';
import { Embeddings } from '@langchain/core/embeddings';
import {
  BaseChatModel,
  type BaseChatModelCallOptions,
  type BindToolsInput,
  type LangSmithParams,
} from '@langchain/core/language_models/chat_models';
import type { BaseLanguageModelInput } from '@langchain/core/language_models/base';
import type { AIMessageChunk, BaseMessage } from '@langchain/core/messages';
import type { ChatResult } from '@langchain/core/outputs';
import type { Runnable } from '@langchain/core/runnables';
import { QAError, TimeoutError } from '../core/errors.js';
import type { BudgetTracker } from '../core/budget.js';
import type { RateLimiter } from './rateLimiter.js';
import { assertNoSecrets, messageText } from './secretGuard.js';

export interface GuardOptions {
  /** Role name, for traces and messages. */
  role: string;
  provider: string;
  model: string;
  timeoutMs: number;
  secrets: () => readonly string[];
  limiter?: RateLimiter;
  budget?: () => BudgetTracker | undefined;
  /** Usage callback (tokens per call) — also used for doctor/tests. */
  onUsage?: (u: { role: string; provider: string; model: string; tokens: number; estimated: boolean }) => void;
}

/** Rough token estimate when a provider returns no usage metadata (4 chars ≈ 1 token). */
const estimateTokens = (chars: number): number => Math.ceil(chars / 4);

function tokensFrom(result: ChatResult, promptChars: number): { tokens: number; estimated: boolean } {
  let total = 0;
  let found = false;
  for (const g of result.generations) {
    const usage = (g.message as Partial<AIMessageChunk>).usage_metadata;
    if (usage && typeof usage.total_tokens === 'number') {
      total += usage.total_tokens;
      found = true;
    }
  }
  if (found) return { tokens: total, estimated: false };
  const llmOutput: unknown = result.llmOutput;
  if (llmOutput && typeof llmOutput === 'object' && 'tokenUsage' in llmOutput) {
    const tu: unknown = llmOutput.tokenUsage;
    if (tu && typeof tu === 'object' && 'totalTokens' in tu && typeof tu.totalTokens === 'number') {
      return { tokens: tu.totalTokens, estimated: false };
    }
  }
  const outChars = result.generations.reduce((n, g) => n + g.text.length, 0);
  return { tokens: estimateTokens(promptChars + outChars), estimated: true };
}

/**
 * Wraps a provider chat model with the router's guarantees, on every call path (invoke, batch, tools, structured
 * output): secret guard → quota → timeout → token accounting. Provider SDK retries are disabled at construction; the
 * resilience policy owns retries.
 */
export class GuardedChatModel extends BaseChatModel {
  readonly guard: GuardOptions;
  readonly inner: BaseChatModel;

  constructor(inner: BaseChatModel, guard: GuardOptions) {
    super({});
    this.inner = inner;
    this.guard = guard;
  }

  static override lc_name(): string {
    return 'GuardedChatModel';
  }

  _llmType(): string {
    // Called by the base constructor before `inner` is assigned.
    const inner = this.inner as BaseChatModel | undefined;
    return `guarded:${inner ? inner._llmType() : 'pending'}`;
  }

  override getLsParams(options: this['ParsedCallOptions']): LangSmithParams {
    return { ...this.inner.getLsParams(options), ls_provider: this.guard.provider, ls_model_name: this.guard.model };
  }

  override bindTools(
    tools: BindToolsInput[],
    kwargs?: Partial<BaseChatModelCallOptions>,
  ): Runnable<BaseLanguageModelInput, AIMessageChunk, BaseChatModelCallOptions> {
    if (!this.inner.bindTools) throw new Error(`${this.guard.provider} model does not support tool calling`);
    // Let the provider format the tools, then re-bind those call options on *this* wrapper so the guard stays on.
    const bound = this.inner.bindTools(tools, kwargs) as unknown as { config?: Record<string, unknown> };
    return this.withConfig(bound.config ?? {});
  }

  async _generate(
    messages: BaseMessage[],
    options: this['ParsedCallOptions'],
    runManager?: CallbackManagerForLLMRun,
  ): Promise<ChatResult> {
    const texts = messages.map(messageText);
    assertNoSecrets(texts, this.guard.secrets(), `the ${this.guard.role} prompt`);
    this.guard.budget?.()?.assertWithin();
    await this.guard.limiter?.acquire();

    const timeoutSignal = AbortSignal.timeout(this.guard.timeoutMs);
    const signal = options.signal ? AbortSignal.any([options.signal, timeoutSignal]) : timeoutSignal;
    let result: ChatResult;
    try {
      result = await raceAbort(this.inner._generate(messages, { ...options, signal }, runManager), signal);
    } catch (err) {
      if (timeoutSignal.aborted) throw new TimeoutError(`${this.guard.role} model call`, this.guard.timeoutMs);
      throw err;
    }

    const promptChars = texts.reduce((n, t) => n + t.length, 0);
    const usage = tokensFrom(result, promptChars);
    this.guard.onUsage?.({
      role: this.guard.role,
      provider: this.guard.provider,
      model: this.guard.model,
      ...usage,
    });
    this.guard.budget?.()?.addTokens(usage.tokens);
    return result;
  }
}

/** Some SDKs ignore AbortSignal; never wait longer than the signal allows. */
function raceAbort<T>(p: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(signal.reason instanceof Error ? signal.reason : new Error('aborted'));
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => {
      reject(signal.reason instanceof Error ? signal.reason : new Error('aborted'));
    };
    signal.addEventListener('abort', onAbort, { once: true });
    p.then(
      (v) => {
        signal.removeEventListener('abort', onAbort);
        resolve(v);
      },
      (e: unknown) => {
        signal.removeEventListener('abort', onAbort);
        reject(e instanceof Error ? e : new Error(String(e)));
      },
    );
  });
}

/** Embeddings with the same secret guard (documents leave the machine too). */
export class GuardedEmbeddings extends Embeddings {
  constructor(
    readonly inner: Embeddings,
    private readonly secrets: () => readonly string[],
    readonly modelName: string,
  ) {
    super({});
  }

  async embedDocuments(documents: string[]): Promise<number[][]> {
    assertNoSecrets(documents, this.secrets(), 'documents sent for embedding');
    return checkVectors(await this.inner.embedDocuments(documents), documents.length, this.modelName);
  }

  async embedQuery(document: string): Promise<number[]> {
    assertNoSecrets([document], this.secrets(), 'an embedding query');
    return checkVectors([await this.inner.embedQuery(document)], 1, this.modelName)[0] ?? [];
  }
}

/**
 * Some provider wrappers (LangChain's Google embeddings) turn a failed batch — e.g. HTTP 429 quota — into empty
 * vectors instead of an error. An empty, NaN or ragged vector is never returned: it becomes a TRANSIENT error that
 * the caller retries with backoff.
 */
export function checkVectors(vectors: number[][], expected: number, model: string): number[][] {
  const dims = vectors[0]?.length ?? 0;
  const bad = vectors.filter((v) => v.length === 0 || v.length !== dims || v.some((x) => !Number.isFinite(x))).length;
  if (vectors.length !== expected || dims === 0 || bad > 0) {
    throw new QAError(
      'TRANSIENT',
      `${model} returned ${bad || expected - vectors.length} empty/invalid vector(s) of ${expected} (provider quota or rate limit — retry later)`,
      {
        status: 429,
      },
    );
  }
  return vectors;
}
