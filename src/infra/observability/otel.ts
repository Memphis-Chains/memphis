/**
 * OpenTelemetry SDK overlay (closes deferred item #3).
 *
 * When `MEMPHIS_OTEL_ENDPOINT` is set, Memphis starts the OTLP/HTTP
 * trace exporter and installs a process-wide tracer. When unset, the
 * SDK is NOT started and this module is an intentional no-op — the
 * `trace.getTracer()` call in the API package returns a proxy tracer
 * that does nothing. No production impact for operators who don't run
 * a collector.
 *
 * Manual instrumentation (as opposed to auto-instrumentation) because
 * Memphis's critical paths are well-bounded: HTTP request, turn
 * execution, provider call, tool call, vault unlock. A few `withSpan`
 * wrappers at the right seams is cheaper and less fragile than
 * pulling in the full `@opentelemetry/auto-instrumentations-node`
 * dependency graph.
 *
 * Env controls:
 *   MEMPHIS_OTEL_ENDPOINT   — OTLP/HTTP trace endpoint (e.g. http://collector:4318/v1/traces).
 *                             When unset, SDK is not started.
 *   MEMPHIS_OTEL_SERVICE_NAME — service.name resource attribute (default "memphis").
 *   MEMPHIS_OTEL_SAMPLE_RATIO — 0–1; defaults to 1 (sample all). When set,
 *                               spans below the ratio are dropped before export.
 *   MEMPHIS_OTEL_HEADERS    — OTLP headers, semicolon-separated
 *                             (e.g. "Authorization=Bearer xyz"). Optional.
 */

import {
  trace,
  context as otContext,
  SpanStatusCode,
  type Span,
  type SpanOptions,
  type Tracer,
} from '@opentelemetry/api';

type NodeSDKInstance = {
  start: () => void;
  shutdown: () => Promise<void>;
};

interface OtelState {
  enabled: boolean;
  endpoint: string | null;
  serviceName: string;
  sdk: NodeSDKInstance | null;
}

let state: OtelState = {
  enabled: false,
  endpoint: null,
  serviceName: 'memphis',
  sdk: null,
};

function parseHeaders(raw: string | undefined): Record<string, string> {
  if (!raw) return {};
  const out: Record<string, string> = {};
  for (const entry of raw.split(';')) {
    const trimmed = entry.trim();
    if (!trimmed) continue;
    const idx = trimmed.indexOf('=');
    if (idx <= 0) continue;
    const key = trimmed.slice(0, idx).trim();
    const value = trimmed.slice(idx + 1).trim();
    if (key && value) out[key] = value;
  }
  return out;
}

function parseSampleRatio(raw: string | undefined): number {
  if (!raw) return 1;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 0 || parsed > 1) return 1;
  return parsed;
}

/**
 * Initialize the OpenTelemetry SDK if and only if
 * `MEMPHIS_OTEL_ENDPOINT` is set. Returns the operational state so
 * bootstrap can log what happened without having to duplicate the
 * env parsing.
 *
 * Safe to call multiple times — second call is a no-op.
 */
export async function initOtelIfEnabled(
  rawEnv: NodeJS.ProcessEnv = process.env,
): Promise<OtelState> {
  if (state.enabled) return state;

  const endpoint = rawEnv.MEMPHIS_OTEL_ENDPOINT?.trim();
  if (!endpoint) {
    state = { enabled: false, endpoint: null, serviceName: 'memphis', sdk: null };
    return state;
  }

  const serviceName = rawEnv.MEMPHIS_OTEL_SERVICE_NAME?.trim() || 'memphis';
  const headers = parseHeaders(rawEnv.MEMPHIS_OTEL_HEADERS);
  const sampleRatio = parseSampleRatio(rawEnv.MEMPHIS_OTEL_SAMPLE_RATIO);

  // Dynamic imports so the SDK is only loaded when actually enabled —
  // keeps startup cost down for operators who never use OTel.
  const { NodeSDK } = await import('@opentelemetry/sdk-node');
  const { OTLPTraceExporter } = await import('@opentelemetry/exporter-trace-otlp-http');
  const { resourceFromAttributes } = await import('@opentelemetry/resources');
  const { ATTR_SERVICE_NAME } = await import('@opentelemetry/semantic-conventions');
  // Codex Round 5 P1 fix: actually wire MEMPHIS_OTEL_SAMPLE_RATIO into
  // the SDK. Without a sampler instance, the parsed value was ignored
  // and traces were always sampled at the SDK default — silently
  // ignoring operator intent (and exporting far more spans than asked).
  const { TraceIdRatioBasedSampler } = await import('@opentelemetry/sdk-trace-base');

  const exporter = new OTLPTraceExporter({ url: endpoint, headers });
  const resource = resourceFromAttributes({
    [ATTR_SERVICE_NAME]: serviceName,
    'memphis.otel.sample_ratio': sampleRatio,
  });

  const sdk = new NodeSDK({
    resource,
    traceExporter: exporter,
    sampler: new TraceIdRatioBasedSampler(sampleRatio),
  }) as unknown as NodeSDKInstance;

  try {
    sdk.start();
  } catch (err) {
    // Bootstrap never fails because of observability — write to stderr
    // and continue. Using process.stderr directly so no logger
    // dependency is pulled into the OTel module.
    process.stderr.write(
      `[memphis-otel] SDK start failed: ${err instanceof Error ? err.message : String(err)}\n`,
    );
    state = { enabled: false, endpoint, serviceName, sdk: null };
    return state;
  }

  state = { enabled: true, endpoint, serviceName, sdk };
  return state;
}

export async function shutdownOtel(): Promise<void> {
  if (!state.sdk) return;
  try {
    await state.sdk.shutdown();
  } catch {
    // best-effort — process is tearing down anyway
  }
  state = { enabled: false, endpoint: null, serviceName: 'memphis', sdk: null };
}

/**
 * Get the Memphis tracer. Safe to call before (or without) SDK init —
 * returns a no-op proxy tracer in that case.
 */
export function getTracer(): Tracer {
  return trace.getTracer('memphis', '1.0.0');
}

/**
 * Wrap an async operation in a span. On unhandled error the span is
 * marked ERROR and the exception is recorded (not swallowed — re-thrown).
 *
 * Usage:
 *     const result = await withSpan('turn.dispatch', { surface: 'http' }, async () => {
 *       return runTurn(...);
 *     });
 */
export async function withSpan<T>(
  name: string,
  attributes: Record<string, string | number | boolean> | undefined,
  fn: (span: Span) => Promise<T>,
  options: SpanOptions = {},
): Promise<T> {
  const tracer = getTracer();
  return tracer.startActiveSpan(
    name,
    { ...options, attributes: { ...attributes, ...(options.attributes ?? {}) } },
    async (span) => {
      try {
        const result = await fn(span);
        span.setStatus({ code: SpanStatusCode.OK });
        return result;
      } catch (err) {
        span.recordException(err as Error);
        span.setStatus({
          code: SpanStatusCode.ERROR,
          message: err instanceof Error ? err.message : String(err),
        });
        throw err;
      } finally {
        span.end();
      }
    },
  );
}

/** Sync variant for hot loops where the async wrapper overhead is unwanted. */
export function withSyncSpan<T>(
  name: string,
  attributes: Record<string, string | number | boolean> | undefined,
  fn: (span: Span) => T,
): T {
  const tracer = getTracer();
  return tracer.startActiveSpan(name, { attributes: attributes ?? {} }, (span) => {
    try {
      const result = fn(span);
      span.setStatus({ code: SpanStatusCode.OK });
      return result;
    } catch (err) {
      span.recordException(err as Error);
      span.setStatus({
        code: SpanStatusCode.ERROR,
        message: err instanceof Error ? err.message : String(err),
      });
      throw err;
    } finally {
      span.end();
    }
  });
}

/** Expose the current OTel state (for /status payloads). */
export function getOtelState(): Pick<OtelState, 'enabled' | 'endpoint' | 'serviceName'> {
  return {
    enabled: state.enabled,
    endpoint: state.endpoint,
    serviceName: state.serviceName,
  };
}

/** Test-only: clear the cached state so re-init runs. */
export function __resetOtelForTests(): void {
  state = { enabled: false, endpoint: null, serviceName: 'memphis', sdk: null };
}

// Re-exports for consumers that want direct access to the API
export { trace, otContext, SpanStatusCode };
export type { Span, Tracer };
