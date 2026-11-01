/**
 * Local JSONL span sink — sovereign-first telemetry fallback.
 *
 * Writes one line per span event to `<dataDir>/telemetry/spans-YYYY-MM-DD.jsonl`,
 * regardless of whether the OpenTelemetry SDK is enabled. The OTel pipeline
 * (otel.ts) only emits when MEMPHIS_OTEL_ENDPOINT is set; without that, spans
 * vanish into the no-op proxy tracer. This module exists so operators can
 * inspect runtime behavior locally without standing up an OTLP collector.
 *
 * Failure handling: a failed write does NOT disable the sink.
 *
 * WHY THAT CHANGED
 * ----------------
 * The first version set a `writeFailedOnce` flag: one failed write and the
 * process stopped emitting telemetry for the rest of its life, with a single
 * line on stderr and nothing else. Measured on this host (2026-10-29), the
 * `tool.call` spans stopped on 2026-10-26 and the SLO report said "no
 * tool.call spans in window" for days — a broken sink that looked exactly
 * like an idle runtime.
 *
 * The sink now:
 *   - retries with exponential backoff (see `sink-retry.ts`), so a transient
 *     error costs a bounded number of attempts instead of all telemetry;
 *   - records its own state in `<dataDir>/sink-status-ts.json`, so the
 *     report can say "the sink is degraded" instead of "there is no data";
 *   - raises an alert through the runtime alert emitter on the first failure
 *     of an outage, and one on recovery.
 *
 * Telemetry must never break the hot path: every failure path here is
 * best-effort and swallows its own errors.
 *
 * Disable with MEMPHIS_TELEMETRY_LOCAL_SINK=false for operators who want pure
 * OTel mode and don't want files growing on disk.
 */

import { appendFileSync } from 'node:fs';
import path from 'node:path';

import {
  initialSinkRetryState,
  sinkMayAttempt,
  sinkRecordFailure,
  sinkRecordSuccess,
  type SinkRetryState,
} from './sink-retry.js';
import { writeSinkStatus } from './sink-status.js';
import { getDataDir, ensureDir } from '../../config/paths.js';
import { getRuntimeAlertEmitter } from '../logging/alert-runtime.js';

export type SpanStatus = 'ok' | 'error';

/** The surface name this arm writes its status file under. */
export const LOCAL_SINK_SURFACE = 'ts';

export interface LocalSpanRecord {
  ts: string;
  name: string;
  attrs: Record<string, string | number | boolean | null>;
  durationMs?: number;
  status: SpanStatus;
  errorMessage?: string;
  events?: Array<{ name: string; attrs?: Record<string, unknown> }>;
}

const sinkState: { retry: SinkRetryState } = { retry: initialSinkRetryState() };

function isEnabled(rawEnv: NodeJS.ProcessEnv = process.env): boolean {
  const flag = rawEnv.MEMPHIS_TELEMETRY_LOCAL_SINK;
  if (flag === undefined) return true;
  const normalized = flag.trim().toLowerCase();
  return !['0', 'false', 'no', 'off'].includes(normalized);
}

function todayStamp(now: Date = new Date()): string {
  const y = now.getUTCFullYear();
  const m = String(now.getUTCMonth() + 1).padStart(2, '0');
  const d = String(now.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function getTelemetryDir(rawEnv: NodeJS.ProcessEnv = process.env): string {
  return path.join(getDataDir(rawEnv), 'telemetry');
}

/**
 * Publish the sink's own state.
 *
 * Best effort: this runs while the sink is already broken, so a failure to
 * write the status file must not raise.
 */
function publishStatus(rawEnv: NodeJS.ProcessEnv, nowMs: number): void {
  try {
    const retry = sinkState.retry;
    writeSinkStatus(getDataDir(rawEnv), {
      surface: LOCAL_SINK_SURFACE,
      state: retry.consecutiveFailures > 0 ? 'degraded' : 'ok',
      consecutiveFailures: retry.consecutiveFailures,
      lastError: retry.lastError,
      lastFailureAt:
        retry.lastFailureAtMs === null ? null : new Date(retry.lastFailureAtMs).toISOString(),
      lastSuccessAt:
        retry.lastSuccessAtMs === null ? null : new Date(retry.lastSuccessAtMs).toISOString(),
      nextRetryAt:
        retry.nextAttemptAtMs === null ? null : new Date(retry.nextAttemptAtMs).toISOString(),
      updatedAt: new Date(nowMs).toISOString(),
    });
  } catch {
    // A status file that cannot be written is a lost breadcrumb, not a
    // reason to break the caller.
  }
}

/**
 * Raise an alert about the sink's state.
 *
 * The alert emitter is asynchronous and its transport may be unconfigured;
 * neither may propagate into the caller.
 */
function raiseAlert(
  rawEnv: NodeJS.ProcessEnv,
  alert: {
    id: string;
    severity: 'high' | 'medium' | 'low';
    message: string;
    details: Record<string, unknown>;
  },
): void {
  try {
    const emitter = getRuntimeAlertEmitter(rawEnv);
    void emitter.emit(alert).catch(() => undefined);
  } catch {
    // An alert that cannot be raised must not break the caller.
  }
}

export function getSpansFilePath(
  rawEnv: NodeJS.ProcessEnv = process.env,
  now: Date = new Date(),
): string {
  return path.join(getTelemetryDir(rawEnv), `spans-${todayStamp(now)}.jsonl`);
}

/**
 * The sink's current retry state.
 *
 * Exposed so the health and SLO surfaces can report a degraded sink
 * instead of reporting "no data".
 */
export function getLocalSinkRetryState(): SinkRetryState {
  return { ...sinkState.retry };
}

export function recordLocalSpan(
  record: Omit<LocalSpanRecord, 'ts'>,
  rawEnv: NodeJS.ProcessEnv = process.env,
  now: Date = new Date(),
): void {
  if (!isEnabled(rawEnv)) return;

  const nowMs = now.getTime();
  if (!sinkMayAttempt(sinkState.retry, nowMs)) return;

  const fullRecord: LocalSpanRecord = {
    ts: now.toISOString(),
    ...record,
  };

  try {
    const dir = ensureDir(getTelemetryDir(rawEnv));
    const filePath = path.join(dir, `spans-${todayStamp(now)}.jsonl`);
    appendFileSync(filePath, JSON.stringify(fullRecord) + '\n', 'utf8');
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const wasHealthy = sinkState.retry.consecutiveFailures === 0;
    sinkState.retry = sinkRecordFailure(sinkState.retry, nowMs, message);
    publishStatus(rawEnv, nowMs);
    process.stderr.write(
      `[memphis-telemetry] local span sink write failed (${sinkState.retry.consecutiveFailures}x): ${message}\n`,
    );
    if (wasHealthy) {
      raiseAlert(rawEnv, {
        id: 'LocalSpanSinkDegraded',
        severity: 'high',
        message: 'The local telemetry sink cannot write spans',
        details: {
          surface: LOCAL_SINK_SURFACE,
          error: message,
          retryAt: sinkState.retry.nextAttemptAtMs
            ? new Date(sinkState.retry.nextAttemptAtMs).toISOString()
            : null,
        },
      });
    }
    return;
  }

  const wasDegraded = sinkState.retry.consecutiveFailures > 0;
  sinkState.retry = sinkRecordSuccess(sinkState.retry, nowMs);
  if (wasDegraded) {
    publishStatus(rawEnv, nowMs);
    process.stderr.write('[memphis-telemetry] local span sink recovered\n');
    raiseAlert(rawEnv, {
      id: 'LocalSpanSinkRecovered',
      severity: 'medium',
      message: 'The local telemetry sink writes spans again',
      details: { surface: LOCAL_SINK_SURFACE },
    });
  }
}

/** Test-only: reset the retry state (test harness). */
export function __resetLocalSinkForTests(): void {
  sinkState.retry = initialSinkRetryState();
}
