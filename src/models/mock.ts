import { createHash } from 'node:crypto';
import { Embeddings } from '@langchain/core/embeddings';
import {
  BaseChatModel,
  type BaseChatModelCallOptions,
  type BindToolsInput,
} from '@langchain/core/language_models/chat_models';
import type { BaseLanguageModelInput } from '@langchain/core/language_models/base';
import { AIMessage, AIMessageChunk, type BaseMessage } from '@langchain/core/messages';
import type { ChatResult } from '@langchain/core/outputs';
import type { Runnable } from '@langchain/core/runnables';
import { messageText } from './secretGuard.js';

/**
 * Deterministic offline model (provider `mock`). Every result produced with it is labelled MOCK (rule 13).
 * A responder decides the answer; by default it returns a fixed JSON marker so nothing can mistake it for real output.
 */
export type MockResponder = (messages: BaseMessage[], callIndex: number) => string | AIMessage;

export interface MockOptions {
  model?: string;
  responder?: MockResponder;
  /** Simulated latency, honours AbortSignal. */
  delayMs?: number;
  /** Throw this error for the first N calls (failure-injection for tests). */
  failFirst?: { times: number; error: () => Error };
}

export const MOCK_DEFAULT_RESPONSE = '{"mock":true,"note":"MOCK provider output - not a real model"}';

export class MockChatModel extends BaseChatModel {
  calls = 0;
  readonly opts: MockOptions;

  constructor(opts: MockOptions = {}) {
    super({});
    this.opts = opts;
  }

  _llmType(): string {
    return 'mock';
  }

  override bindTools(
    _tools: BindToolsInput[],
    kwargs?: Partial<BaseChatModelCallOptions>,
  ): Runnable<BaseLanguageModelInput, AIMessageChunk, BaseChatModelCallOptions> {
    return this.withConfig(kwargs ?? {});
  }

  async _generate(messages: BaseMessage[], options: this['ParsedCallOptions']): Promise<ChatResult> {
    const index = this.calls++;
    if (this.opts.delayMs) await abortableDelay(this.opts.delayMs, options.signal);
    if (this.opts.failFirst && index < this.opts.failFirst.times) throw this.opts.failFirst.error();
    const out = this.opts.responder?.(messages, index) ?? MOCK_DEFAULT_RESPONSE;
    const src = typeof out === 'string' ? new AIMessage(out) : out;
    const text = typeof src.content === 'string' ? src.content : JSON.stringify(src.content);
    const input = Math.ceil(messages.map(messageText).join('').length / 4);
    const output = Math.ceil((text.length + JSON.stringify(src.tool_calls ?? []).length) / 4);
    // LangChain core 1.x chat models emit AIMessageChunk; output parsers rely on it.
    const msg = new AIMessageChunk({
      content: src.content,
      tool_calls: src.tool_calls ?? [],
      usage_metadata: { input_tokens: input, output_tokens: output, total_tokens: input + output },
      response_metadata: { ...src.response_metadata, environment: 'MOCK', model: this.opts.model ?? 'mock' },
    });
    return { generations: [{ text, message: msg }] };
  }
}

function abortableDelay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(resolve, ms);
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(t);
        reject(new Error('aborted'));
      },
      { once: true },
    );
  });
}

/** Deterministic hash embeddings: same text → same vector; no network. */
export class MockEmbeddings extends Embeddings {
  constructor(readonly dimensions = 64) {
    super({});
  }

  private vector(text: string): number[] {
    const out: number[] = [];
    let block = 0;
    while (out.length < this.dimensions) {
      const h = createHash('sha256').update(`${block++}:${text}`).digest();
      for (const byte of h) {
        if (out.length >= this.dimensions) break;
        out.push(byte / 127.5 - 1);
      }
    }
    const norm = Math.sqrt(out.reduce((n, v) => n + v * v, 0)) || 1;
    return out.map((v) => v / norm);
  }

  embedDocuments(documents: string[]): Promise<number[][]> {
    return Promise.resolve(documents.map((d) => this.vector(d)));
  }

  embedQuery(document: string): Promise<number[]> {
    return Promise.resolve(this.vector(document));
  }
}
