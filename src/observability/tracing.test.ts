import { trace } from '@opentelemetry/api';
import {
  BasicTracerProvider,
  InMemorySpanExporter,
  SimpleSpanProcessor,
  type ReadableSpan,
  type SpanExporter,
  type SpanProcessor,
} from '@opentelemetry/sdk-trace-base';
import { ExportResultCode } from '@opentelemetry/core';
import { afterEach, describe, expect, it } from 'vitest';
import { ModelsConfig, ObservabilityConfig } from '../config/schemas.js';
import { ModelRouter } from '../models/router.js';
import { Redactor } from '../security/redact.js';
import { OMITTED, redactSpan } from './redactingProcessor.js';
import { initTracing, runAttributes, type Tracing } from './tracing.js';

const obsConfig = (over: Partial<Record<string, unknown>> = {}): ObservabilityConfig =>
  ObservabilityConfig.parse({
    exporters: { langfuse: { enabled: false }, phoenix: { enabled: false } },
    redactBeforeExport: true,
    includeScreenshots: false,
    tags: ['runId'],
    perOrgProfile: { 'prod-test-org': { langfuse: false, phoenix: false } },
    onExporterError: 'warn',
    ...over,
  });

async function mockRouter(): Promise<ModelRouter> {
  return ModelRouter.create({
    config: ModelsConfig.parse({
      roles: {
        reasoning: { provider: 'mock', model: 'a' },
        coder: { provider: 'mock', model: 'b' },
        fast: { provider: 'mock', model: 'c' },
        judge: { provider: 'mock', model: 'd' },
      },
      embeddings: { provider: 'mock', model: 'e' },
      budgets: { tokensPerRun: 10_000, minutesPerRun: 10 },
    }),
    secrets: { get: () => Promise.resolve(undefined), setting: () => undefined },
    secretValues: () => [],
  });
}

let tracing: Tracing | undefined;
afterEach(async () => {
  await tracing?.shutdown();
  tracing = undefined;
});

const allText = (spans: readonly ReadableSpan[]): string =>
  JSON.stringify(spans.map((s) => ({ n: s.name, a: s.attributes, e: s.events })));

describe('redactSpan', () => {
  it('redacts PII, drops screenshot attributes and binary payloads, keeps span identity', () => {
    const exporter = new InMemorySpanExporter();
    const provider = new BasicTracerProvider({ spanProcessors: [new SimpleSpanProcessor(exporter)] });
    const span = provider.getTracer('t').startSpan('login jane@acme.example');
    span.setAttributes({
      'input.value': 'call jane@acme.example',
      'qa.screenshot': 'iVBORw0KGgo',
      'llm.input_messages.0.message.contents.1.message_content.image.image.url': 'data:image/png;base64,AAAA',
      'tool.output': `data:image/png;base64,${'A'.repeat(50)}`,
      blob: 'A'.repeat(3000),
      count: 3,
    });
    span.addEvent('exception', { 'exception.message': 'failed for jane@acme.example' });
    span.end();
    const original = exporter.getFinishedSpans()[0]!;
    const red = redactSpan(original, new Redactor());
    expect(red.name).toBe('login <EMAIL_1>');
    expect(red.attributes).toEqual({
      'input.value': 'call <EMAIL_1>',
      'tool.output': OMITTED,
      blob: OMITTED,
      count: 3,
    });
    expect(red.events[0]?.attributes?.['exception.message']).toBe('failed for <EMAIL_1>');
    expect(red.spanContext().spanId).toBe(original.spanContext().spanId);
    expect(original.attributes['input.value']).toBe('call jane@acme.example'); // original untouched
  });
});

describe('initTracing', () => {
  it('instruments LangChain once; LLM spans are redacted before any exporter sees them', async () => {
    const mem = new InMemorySpanExporter();
    tracing = await initTracing({
      config: obsConfig(),
      env: {},
      redactor: new Redactor(),
      extraProcessors: [new SimpleSpanProcessor(mem)],
    });
    const router = await mockRouter();
    await tracing.tracer.startActiveSpan(
      'node:understand',
      { attributes: runAttributes({ runId: 'run-1' }) },
      async (s) => {
        await router.get('reasoning').invoke('Customer email is jane@acme.example, phone +1 415 555 0134');
        s.end();
      },
    );
    await tracing.flush();
    const spans = mem.getFinishedSpans();
    expect(spans.length).toBeGreaterThanOrEqual(2);
    const text = allText(spans);
    expect(text).toContain('<EMAIL_1>');
    expect(text).not.toContain('jane@acme.example');
    expect(text).not.toContain('555 0134');
    const llm = spans.find((s) => s.attributes['openinference.span.kind'] === 'LLM');
    expect(llm, 'OpenInference LLM span present').toBeDefined();
    const root = spans.find((s) => s.name === 'node:understand');
    expect(root?.attributes['langfuse.session.id']).toBe('run-1');
    expect(llm?.parentSpanContext?.traceId).toBe(root?.spanContext().traceId);
  });

  it('a throwing destination never breaks the run — it becomes a warning', async () => {
    const broken: SpanProcessor = {
      onStart: () => {
        throw new Error('collector exploded on start');
      },
      onEnd: () => {
        throw new Error('collector exploded');
      },
      forceFlush: () => Promise.reject(new Error('flush exploded')),
      shutdown: () => Promise.resolve(),
    };
    tracing = await initTracing({ config: obsConfig(), env: {}, redactor: new Redactor(), extraProcessors: [broken] });
    const router = await mockRouter();
    await expect(router.get('fast').invoke('hello')).resolves.toBeDefined();
    await tracing.flush();
    expect(tracing.warnings.some((w) => w.includes('collector exploded'))).toBe(true);
    expect(tracing.warnings.some((w) => w.includes('flush exploded'))).toBe(true);
  });

  it('an exporter reporting failure is a warning, not an exception', async () => {
    const failing: SpanExporter = {
      export: (_spans, cb) => {
        cb({ code: ExportResultCode.FAILED, error: new Error('HTTP 503 from collector') });
      },
      shutdown: () => Promise.resolve(),
    };
    tracing = await initTracing({
      config: obsConfig(),
      env: {},
      redactor: new Redactor(),
      extraProcessors: [new SimpleSpanProcessor(failing)],
    });
    trace.getTracer('t').startSpan('x').end();
    await tracing.flush();
    expect(tracing.warnings.join(' ')).toMatch(/503|exporter error/);
  });

  it('langfuse enabled without keys → not exporting, explained', async () => {
    tracing = await initTracing({
      config: obsConfig({ exporters: { langfuse: { enabled: true }, phoenix: { enabled: false } } }),
      env: {},
      redactor: new Redactor(),
      instrumentLangChain: false,
    });
    expect(tracing.destinations.find((d) => d.name === 'langfuse')).toMatchObject({
      enabled: false,
      reason: 'keys missing in .env',
    });
  });

  it('per-org-profile override disables Langfuse for prod-test-org', async () => {
    tracing = await initTracing({
      config: obsConfig({ exporters: { langfuse: { enabled: true }, phoenix: { enabled: false } } }),
      env: { LANGFUSE_PUBLIC_KEY: 'pk-lf-x', LANGFUSE_SECRET_KEY: 'sk-lf-y' },
      redactor: new Redactor(),
      orgProfile: 'prod-test-org',
      instrumentLangChain: false,
    });
    expect(tracing.destinations.find((d) => d.name === 'langfuse')).toMatchObject({
      enabled: false,
      reason: 'disabled for org profile prod-test-org',
    });
  });

  it('builds a Langfuse processor when keys exist (no network until spans are flushed)', async () => {
    tracing = await initTracing({
      config: obsConfig({ exporters: { langfuse: { enabled: true }, phoenix: { enabled: false } } }),
      env: { LANGFUSE_PUBLIC_KEY: 'pk-lf-x', LANGFUSE_SECRET_KEY: 'sk-lf-y', LANGFUSE_BASE_URL: 'http://127.0.0.1:9' },
      redactor: new Redactor(),
      instrumentLangChain: false,
    });
    expect(tracing.destinations.find((d) => d.name === 'langfuse')?.enabled).toBe(true);
    trace.getTracer('t').startSpan('x').end();
    await tracing.flush(); // unreachable host: must not throw
  });

  it('runAttributes tags runs for Langfuse grouping', () => {
    expect(runAttributes({ runId: 'r1', storyKey: 'SF-1', agent: 'qa-lead' })).toEqual({
      'langfuse.session.id': 'r1',
      'qa.runId': 'r1',
      'qa.storyKey': 'SF-1',
      'qa.agent': 'qa-lead',
      'langfuse.trace.metadata.runId': 'r1',
      'langfuse.trace.metadata.storyKey': 'SF-1',
      'langfuse.trace.metadata.agent': 'qa-lead',
      'langfuse.trace.tags': ['runId:r1', 'storyKey:SF-1', 'agent:qa-lead'],
    });
  });
});
