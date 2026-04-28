/**
 * Unified instrumentation wrapper.
 *
 * `instrument(name, attrs, fn)` runs the supplied async fn while:
 *   1. Creating an OpenTelemetry span via `withSpan` (no-op when OTel SDK is
 *      not enabled — the API package returns a proxy tracer).
 *   2. Emitting a parallel local JSONL record via `recordLocalSpan`, so spans
 *      are observable on operator boxes without an OTLP collector.
 *
 * The local record captures duration and status; the OTel span captures the
 * same plus parent context for distributed tracing. Either path can be
 * disabled independently (MEMPHIS_OTEL_ENDPOINT for OTel,
 * MEMPHIS_TELEMETRY_LOCAL_SINK for the JSONL sink).
 *
 * Use this from gateway/agent/provider boundaries (Sprint 0.1 adoption — see
 * docs/roadmap and `feat(otel): adopt withSpan` PR).
 */

import { recordLocalSpan, type SpanStatus } from './console-exporter.js';
import { withSpan } from './otel.js';

export type SpanAttributes = Record<string, string | number | boolean>;

/**
 * Classify a tool's stringified JSON output as success / error / unknown.
 *
 * Foundation for Sprint 1.3 (anti-confabulation guard) — the agent loop will
 * use the same classifier to decide whether to inject a "do not claim
 * success" system message before the next LLM turn.
 *
 * Rules:
 *  - parsed object with `error` key, or `blocked: true`, or `ok: false` → error
 *  - any other parsed object/array → success
 *  - parse failure → unknown (raw string output, e.g. plain text)
 */
export function classifyToolOutput(output: string): 'success' | 'error' | 'unknown' {
  try {
    const parsed: unknown = JSON.parse(output);
    if (parsed !== null && typeof parsed === 'object') {
      const obj = parsed as Record<string, unknown>;
      if ('error' in obj) return 'error';
      if (obj.blocked === true) return 'error';
      if (obj.ok === false) return 'error';
    }
    return 'success';
  } catch {
    return 'unknown';
  }
}

export interface InstrumentOptions {
  /** Attributes evaluated *after* fn runs (e.g. classifying the result). */
  postAttributes?: (result: unknown) => SpanAttributes;
}

/**
 * Wrap an async operation with both OTel span + local JSONL record.
 *
 * The local record is written even if the OTel SDK is not enabled — that's
 * the whole point of this wrapper.
 */
export async function instrument<T>(
  name: string,
  attributes: SpanAttributes,
  fn: () => Promise<T>,
  options: InstrumentOptions = {},
): Promise<T> {
  const startedAt = Date.now();
  let status: SpanStatus = 'ok';
  let errorMessage: string | undefined;
  let result: T | undefined;
  let thrown: unknown;

  try {
    result = await withSpan(name, attributes, async (span) => {
      const inner = await fn();
      // Promote post-attributes to OTel span when caller supplies them.
      if (options.postAttributes) {
        const post = options.postAttributes(inner);
        for (const [key, value] of Object.entries(post)) {
          if (value !== null && value !== undefined) {
            span.setAttribute(key, value as string | number | boolean);
          }
        }
      }
      return inner;
    });
  } catch (err) {
    status = 'error';
    errorMessage = err instanceof Error ? err.message : String(err);
    thrown = err;
  }

  const durationMs = Date.now() - startedAt;
  const finalAttrs: SpanAttributes = { ...attributes };
  if (status === 'ok' && options.postAttributes && result !== undefined) {
    Object.assign(finalAttrs, options.postAttributes(result));
  }

  recordLocalSpan({
    name,
    attrs: finalAttrs,
    durationMs,
    status,
    errorMessage,
  });

  if (thrown !== undefined) throw thrown;
  return result as T;
}
