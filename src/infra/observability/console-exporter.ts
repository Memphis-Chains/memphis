/**
 * Local JSONL span sink — sovereign-first telemetry fallback.
 *
 * Writes one line per span event to `<dataDir>/telemetry/spans-YYYY-MM-DD.jsonl`,
 * regardless of whether the OpenTelemetry SDK is enabled. The OTel pipeline
 * (otel.ts) only emits when MEMPHIS_OTEL_ENDPOINT is set; without that, spans
 * vanish into the no-op proxy tracer. This module exists so operators can
 * inspect runtime behavior locally without standing up an OTLP collector.
 *
 * Failure handling is fire-and-forget: any write error is reported once to
 * stderr and the failure flag is set so subsequent calls go silent — telemetry
 * must never break the hot path.
 *
 * Disable with MEMPHIS_TELEMETRY_LOCAL_SINK=false for operators who want pure
 * OTel mode and don't want files growing on disk.
 */

import { appendFileSync } from 'node:fs';
import path from 'node:path';

import { getDataDir, ensureDir } from '../../config/paths.js';

export type SpanStatus = 'ok' | 'error';

export interface LocalSpanRecord {
  ts: string;
  name: string;
  attrs: Record<string, string | number | boolean | null>;
  durationMs?: number;
  status: SpanStatus;
  errorMessage?: string;
  events?: Array<{ name: string; attrs?: Record<string, unknown> }>;
}

let writeFailedOnce = false;

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

export function getSpansFilePath(
  rawEnv: NodeJS.ProcessEnv = process.env,
  now: Date = new Date(),
): string {
  return path.join(getTelemetryDir(rawEnv), `spans-${todayStamp(now)}.jsonl`);
}

export function recordLocalSpan(
  record: Omit<LocalSpanRecord, 'ts'>,
  rawEnv: NodeJS.ProcessEnv = process.env,
): void {
  if (!isEnabled(rawEnv)) return;
  if (writeFailedOnce) return;

  const fullRecord: LocalSpanRecord = {
    ts: new Date().toISOString(),
    ...record,
  };

  try {
    const dir = ensureDir(getTelemetryDir(rawEnv));
    const filePath = path.join(dir, `spans-${todayStamp()}.jsonl`);
    appendFileSync(filePath, JSON.stringify(fullRecord) + '\n', 'utf8');
  } catch (err) {
    writeFailedOnce = true;
    process.stderr.write(
      `[memphis-telemetry] local span sink disabled after first failure: ${
        err instanceof Error ? err.message : String(err)
      }\n`,
    );
  }
}

/** Test-only: re-enable writes after failure (test harness). */
export function __resetLocalSinkForTests(): void {
  writeFailedOnce = false;
}
