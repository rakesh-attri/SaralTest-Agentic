import { diag, DiagLogLevel, trace, type Attributes, type Tracer } from '@opentelemetry/api';
import { setGlobalErrorHandler } from '@opentelemetry/core';
import { resourceFromAttributes } from '@opentelemetry/resources';
import { BatchSpanProcessor, type SpanProcessor } from '@opentelemetry/sdk-trace-base';
import { NodeTracerProvider } from '@opentelemetry/sdk-trace-node';
import type { Logger } from '../core/logger.js';
import type { Env } from '../config/env.js';
import type { ObservabilityConfig } from '../config/schemas.js';
import type { Redactor } from '../security/redact.js';
import { RedactingSpanProcessor, warnVia } from './redactingProcessor.js';

export interface TracingOptions {
  config: ObservabilityConfig;
  env: Env;
  redactor: Redactor;
  logger?: Logger;
  /** Applies `perOrgProfile` overrides (e.g. prod-test-org → local Phoenix only). */
  orgProfile?: string;
  serviceVersion?: string;
  /** Extra destinations (tests: InMemorySpanExporter). Also wrapped with redaction. */
  extraProcessors?: SpanProcessor[];
  /** Skip LangChain auto-instrumentation (tests that only check processors). */
  instrumentLangChain?: boolean;
}

export interface DestinationStatus {
  name: 'langfuse' | 'phoenix';
  enabled: boolean;
  reason: string;
}

export interface Tracing {
  tracer: Tracer;
  destinations: DestinationStatus[];
  warnings: string[];
  flush(): Promise<void>;
  shutdown(): Promise<void>;
}

let active: Tracing | undefined;
/** The LangChain instrumentation patches the module once per process; later inits only re-point it. */
let langChainInstrumentation: { setTracerProvider(p: NodeTracerProvider): void } | undefined;

/** Tags required by observability.yaml → span attributes (qa.* for us, langfuse.* for Langfuse grouping). */
export interface RunTags {
  runId: string;
  storyKey?: string;
  orgProfile?: string;
  agent?: string;
  persona?: string;
  autonomy?: string;
}

export function runAttributes(tags: RunTags): Attributes {
  const attrs: Attributes = { 'langfuse.session.id': tags.runId };
  const list: string[] = [];
  for (const [k, v] of Object.entries(tags) as [string, string | undefined][]) {
    if (v === undefined) continue;
    attrs[`qa.${k}`] = v;
    attrs[`langfuse.trace.metadata.${k}`] = v;
    list.push(`${k}:${v}`);
  }
  attrs['langfuse.trace.tags'] = list;
  return attrs;
}

function resolveDestinations(opts: TracingOptions): { langfuse: boolean; phoenix: boolean } {
  const base = { langfuse: opts.config.exporters.langfuse.enabled, phoenix: opts.config.exporters.phoenix.enabled };
  const override = opts.orgProfile ? opts.config.perOrgProfile[opts.orgProfile] : undefined;
  return override ? { ...override } : base;
}

/**
 * One OpenTelemetry provider, instrumented ONCE (OpenInference LangChain instrumentation — never also the Langfuse
 * callback handler). Destinations come from config/observability.yaml; every destination is wrapped so redaction
 * runs before export and exporter failures are warnings only (CLAUDE.md rule 17).
 */
export async function initTracing(opts: TracingOptions): Promise<Tracing> {
  if (active) return active;
  const warnings: string[] = [];
  const warn = warnVia(opts.logger, warnings);

  // Exporter/network errors surface through OTel's global handler and diag logger → warnings, never exceptions.
  setGlobalErrorHandler((err) => {
    warn(`exporter error: ${err instanceof Error ? err.message : JSON.stringify(err)}`);
  });
  diag.setLogger(
    {
      error: (m) => {
        warn(`otel: ${m}`);
      },
      warn: (m) => {
        warn(`otel: ${m}`);
      },
      info: () => undefined,
      debug: () => undefined,
      verbose: () => undefined,
    },
    { logLevel: DiagLogLevel.WARN, suppressOverrideMessage: true },
  );

  const wanted = resolveDestinations(opts);
  const processors: SpanProcessor[] = [];
  const destinations: DestinationStatus[] = [];

  if (wanted.langfuse) {
    const { LANGFUSE_PUBLIC_KEY: pk, LANGFUSE_SECRET_KEY: sk, LANGFUSE_BASE_URL: baseUrl } = opts.env;
    if (pk && sk) {
      try {
        const { LangfuseSpanProcessor } = await import('@langfuse/otel');
        const lf = new LangfuseSpanProcessor({
          publicKey: pk,
          secretKey: sk,
          ...(baseUrl ? { baseUrl } : {}),
          // Defence in depth: Langfuse's own mask also runs our redactor on input/output payloads.
          mask: ({ data }: { data: unknown }) =>
            typeof data === 'string' ? opts.redactor.redactText(data) : opts.redactor.redactValue(data),
          mediaUploadEnabled: false,
        });
        processors.push(new RedactingSpanProcessor('langfuse', lf, opts.redactor, warn));
        destinations.push({ name: 'langfuse', enabled: true, reason: `exporting to ${baseUrl ?? 'Langfuse Cloud'}` });
      } catch (err) {
        warn(`langfuse exporter unavailable: ${err instanceof Error ? err.message : String(err)}`);
        destinations.push({ name: 'langfuse', enabled: false, reason: 'failed to initialise (see warnings)' });
      }
    } else {
      warn('langfuse enabled but LANGFUSE_PUBLIC_KEY / LANGFUSE_SECRET_KEY missing — not exporting');
      destinations.push({ name: 'langfuse', enabled: false, reason: 'keys missing in .env' });
    }
  } else {
    destinations.push({
      name: 'langfuse',
      enabled: false,
      reason: opts.orgProfile ? `disabled for org profile ${opts.orgProfile}` : 'disabled in observability.yaml',
    });
  }

  if (wanted.phoenix) {
    const url = opts.env.PHOENIX_COLLECTOR_ENDPOINT ?? 'http://localhost:6006/v1/traces';
    const { OTLPTraceExporter } = await import('@opentelemetry/exporter-trace-otlp-proto');
    const bsp = new BatchSpanProcessor(new OTLPTraceExporter({ url, timeoutMillis: 5_000 }));
    processors.push(new RedactingSpanProcessor('phoenix', bsp, opts.redactor, warn));
    destinations.push({ name: 'phoenix', enabled: true, reason: `exporting to ${url}` });
  } else {
    destinations.push({ name: 'phoenix', enabled: false, reason: 'disabled' });
  }

  for (const [i, p] of (opts.extraProcessors ?? []).entries()) {
    processors.push(new RedactingSpanProcessor(`extra-${i}`, p, opts.redactor, warn));
  }

  const provider = new NodeTracerProvider({
    resource: resourceFromAttributes({
      'service.name': 'sf-qa-agent',
      'service.version': opts.serviceVersion ?? '0.0.1',
    }),
    spanProcessors: processors,
  });
  provider.register();

  if (opts.instrumentLangChain !== false) {
    if (langChainInstrumentation) {
      langChainInstrumentation.setTracerProvider(provider);
    } else {
      const { LangChainInstrumentation } = await import('@arizeai/openinference-instrumentation-langchain');
      const CallbackManagerModule = await import('@langchain/core/callbacks/manager');
      const inst = new LangChainInstrumentation({ tracerProvider: provider });
      inst.manuallyInstrument(CallbackManagerModule);
      langChainInstrumentation = inst;
    }
  }

  const tracing: Tracing = {
    tracer: trace.getTracer('sf-qa-agent'),
    destinations,
    warnings,
    flush: async () => {
      try {
        await provider.forceFlush();
      } catch (err) {
        warn(`flush failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    },
    shutdown: async () => {
      try {
        await provider.shutdown();
      } catch (err) {
        warn(`shutdown failed: ${err instanceof Error ? err.message : String(err)}`);
      }
      trace.disable();
      active = undefined;
    },
  };
  active = tracing;
  return tracing;
}

/**
 * Langfuse reachability for `qa doctor`: authenticated GET of the public health endpoint. Keys go in the
 * Authorization header only.
 */
export async function checkLangfuse(
  env: Env,
  timeoutMs = 10_000,
  fetchImpl: typeof fetch = fetch,
): Promise<{ ok: boolean; detail: string }> {
  const { LANGFUSE_PUBLIC_KEY: pk, LANGFUSE_SECRET_KEY: sk } = env;
  const base = (env.LANGFUSE_BASE_URL ?? 'https://cloud.langfuse.com').replace(/\/$/, '');
  if (!pk || !sk) return { ok: false, detail: 'LANGFUSE_PUBLIC_KEY / LANGFUSE_SECRET_KEY not set' };
  try {
    const auth = Buffer.from(`${pk}:${sk}`).toString('base64');
    const health = await fetchImpl(`${base}/api/public/health`, { signal: AbortSignal.timeout(timeoutMs) });
    if (!health.ok) return { ok: false, detail: `${base} health → HTTP ${health.status}` };
    // An authenticated, read-only call proves the keys belong to a project.
    const proj = await fetchImpl(`${base}/api/public/projects`, {
      headers: { authorization: `Basic ${auth}` },
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (proj.status === 401 || proj.status === 403)
      return { ok: false, detail: `keys rejected by ${base} (HTTP ${proj.status})` };
    if (!proj.ok) return { ok: false, detail: `${base} projects → HTTP ${proj.status}` };
    return { ok: true, detail: `reachable and keys accepted (${base})` };
  } catch (err) {
    return { ok: false, detail: `${base} unreachable: ${err instanceof Error ? err.message : String(err)}` };
  }
}
