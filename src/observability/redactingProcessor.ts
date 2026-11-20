import type { Context } from '@opentelemetry/api';
import type { ReadableSpan, Span, SpanProcessor } from '@opentelemetry/sdk-trace-base';
import type { Attributes, AttributeValue } from '@opentelemetry/api';
import type { Logger } from '../core/logger.js';
import type { Redactor } from '../security/redact.js';

/** Attribute keys that may carry images/screenshots — never exported (CLAUDE.md rule 17). */
const IMAGE_KEY = /screenshot|image|\.data$|base64/i;
const DATA_URL = /^data:(image|application\/octet-stream)[^,]*,/i;
const LONG_BASE64 = /^[A-Za-z0-9+/=\r\n]{2000,}$/;
export const OMITTED = '[binary omitted]';

function cleanValue(key: string, v: AttributeValue | undefined, redactor: Redactor): AttributeValue | undefined {
  if (v === undefined) return v;
  if (IMAGE_KEY.test(key)) return undefined;
  if (typeof v === 'string') {
    if (DATA_URL.test(v) || LONG_BASE64.test(v)) return OMITTED;
    return redactor.redactText(v);
  }
  if (Array.isArray(v)) {
    return v.map((x: unknown) =>
      typeof x === 'string' ? (DATA_URL.test(x) || LONG_BASE64.test(x) ? OMITTED : redactor.redactText(x)) : x,
    ) as AttributeValue;
  }
  return v;
}

export function redactAttributes(attrs: Attributes, redactor: Redactor): Attributes {
  const out: Attributes = {};
  for (const [k, v] of Object.entries(attrs)) {
    const c = cleanValue(k, v, redactor);
    if (c !== undefined) out[k] = c;
  }
  return out;
}

/** A redacted view of a finished span; methods (spanContext) still resolve through the original. */
export function redactSpan(span: ReadableSpan, redactor: Redactor): ReadableSpan {
  const view = Object.create(span) as ReadableSpan;
  Object.defineProperties(view, {
    name: { value: redactor.redactText(span.name) },
    attributes: { value: redactAttributes(span.attributes, redactor) },
    events: {
      value: span.events.map((e) => ({
        ...e,
        name: redactor.redactText(e.name),
        ...(e.attributes ? { attributes: redactAttributes(e.attributes, redactor) } : {}),
      })),
    },
    status: {
      value: { ...span.status, ...(span.status.message ? { message: redactor.redactText(span.status.message) } : {}) },
    },
  });
  return view;
}

/**
 * Wraps an exporter's span processor: redaction runs BEFORE export (rule 17) and failures of the wrapped processor are
 * downgraded to warnings — tracing problems never stop a run.
 */
export class RedactingSpanProcessor implements SpanProcessor {
  constructor(
    readonly name: string,
    private readonly inner: SpanProcessor,
    private readonly redactor: Redactor,
    private readonly onWarn: (msg: string) => void,
  ) {}

  private safe(what: string, fn: () => void): void {
    try {
      fn();
    } catch (err) {
      this.onWarn(`${this.name} ${what} failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  onStart(span: Span, parentContext: Context): void {
    this.safe('onStart', () => {
      this.inner.onStart(span, parentContext);
    });
  }

  onEnd(span: ReadableSpan): void {
    this.safe('onEnd', () => {
      this.inner.onEnd(redactSpan(span, this.redactor));
    });
  }

  async forceFlush(): Promise<void> {
    try {
      await this.inner.forceFlush();
    } catch (err) {
      this.onWarn(`${this.name} flush failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  async shutdown(): Promise<void> {
    try {
      await this.inner.shutdown();
    } catch (err) {
      this.onWarn(`${this.name} shutdown failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}

export function warnVia(logger: Logger | undefined, sink: string[]): (msg: string) => void {
  return (msg) => {
    sink.push(msg);
    logger?.warn({ component: 'tracing' }, msg);
  };
}
