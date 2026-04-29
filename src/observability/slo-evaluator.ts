import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

import { getDataDir } from '../config/paths.js';

export type SloStatus = 'pass' | 'fail' | 'unavailable';

export interface SloResult {
  name: string;
  description: string;
  threshold: number;
  thresholdUnit: string;
  thresholdDirection: 'below' | 'above';
  value: number | null;
  status: SloStatus;
  samples: number;
  reason?: string;
}

export interface SloReport {
  windowDays: number;
  windowStart: string;
  windowEnd: string;
  spanFilesScanned: number;
  totalSamples: number;
  slos: SloResult[];
}

interface SpanRecord {
  ts: string;
  name: string;
  attrs?: Record<string, unknown>;
  durationMs?: number;
  status?: 'ok' | 'error';
}

const SPANS_FILE_RE = /^spans-(\d{4}-\d{2}-\d{2})\.jsonl$/;

function readSpansInWindow(
  rawEnv: NodeJS.ProcessEnv,
  windowStart: Date,
): { spans: SpanRecord[]; filesScanned: number } {
  const dir = join(getDataDir(rawEnv), 'telemetry');
  if (!existsSync(dir)) return { spans: [], filesScanned: 0 };
  let filesScanned = 0;
  const spans: SpanRecord[] = [];
  const startMs = windowStart.getTime();
  // Filename-level filter so 5 years of historical telemetry don't get
  // read fully on a windowDays=1 query. Each file's date stamp is the
  // earliest possible ts of any span in it; a file whose stamp is before
  // the start of the window can still be partially in-window only when
  // its day is the same as the window-start day, so we keep "today of
  // window-start" plus everything stamped after it.
  const windowStartDayMs = Date.UTC(
    windowStart.getUTCFullYear(),
    windowStart.getUTCMonth(),
    windowStart.getUTCDate(),
  );
  for (const entry of readdirSync(dir)) {
    const match = SPANS_FILE_RE.exec(entry);
    if (!match) continue;
    const fileDayMs = Date.parse(`${match[1]}T00:00:00Z`);
    if (Number.isNaN(fileDayMs) || fileDayMs < windowStartDayMs) continue;
    const fullPath = join(dir, entry);
    if (!statSync(fullPath).isFile()) continue;
    filesScanned += 1;
    const content = readFileSync(fullPath, 'utf8');
    for (const line of content.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      let parsed: SpanRecord;
      try {
        parsed = JSON.parse(trimmed) as SpanRecord;
      } catch {
        continue;
      }
      if (typeof parsed.ts !== 'string') continue;
      const tsMs = Date.parse(parsed.ts);
      if (Number.isNaN(tsMs) || tsMs < startMs) continue;
      spans.push(parsed);
    }
  }
  return { spans, filesScanned };
}

function percentile(values: number[], p: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[idx] ?? null;
}

function computeP99TurnLatency(spans: SpanRecord[]): SloResult {
  const turnSpans = spans.filter((s) => s.name === 'turn.dispatch');
  const latencies: number[] = [];
  for (const s of turnSpans) {
    const fromAttr = s.attrs?.['turn.timing_ms'];
    const fromDuration = s.durationMs;
    const v =
      typeof fromAttr === 'number' ? fromAttr : typeof fromDuration === 'number' ? fromDuration : null;
    if (typeof v === 'number' && Number.isFinite(v) && v >= 0) latencies.push(v);
  }
  const p99 = percentile(latencies, 99);
  const threshold = 3000;
  const status: SloStatus =
    p99 === null ? 'unavailable' : p99 <= threshold ? 'pass' : 'fail';
  return {
    name: 'p99_turn_latency_ms',
    description: 'p99 of turn.dispatch latency over the window',
    threshold,
    thresholdUnit: 'ms',
    thresholdDirection: 'below',
    value: p99,
    status,
    samples: latencies.length,
    reason: p99 === null ? 'no turn.dispatch spans with latency in window' : undefined,
  };
}

function computeConfabulationRate(spans: SpanRecord[]): SloResult {
  const turnCount = spans.filter((s) => s.name === 'turn.dispatch').length;
  const confabCount = spans.filter((s) => s.name === 'confabulation.event').length;
  const threshold = 0.001; // 0.1%
  if (turnCount === 0) {
    return {
      name: 'confabulation_rate',
      description: 'Ratio of confabulation.event to turn.dispatch over the window',
      threshold,
      thresholdUnit: 'ratio',
      thresholdDirection: 'below',
      value: null,
      status: 'unavailable',
      samples: 0,
      reason: 'no turn.dispatch spans in window',
    };
  }
  const rate = confabCount / turnCount;
  return {
    name: 'confabulation_rate',
    description: 'Ratio of confabulation.event to turn.dispatch over the window',
    threshold,
    thresholdUnit: 'ratio',
    thresholdDirection: 'below',
    value: rate,
    status: rate <= threshold ? 'pass' : 'fail',
    samples: turnCount,
  };
}

function computeProviderErrorRate(spans: SpanRecord[]): SloResult {
  const providerSpans = spans.filter((s) => s.name === 'provider.completion');
  const errorSpans = providerSpans.filter((s) => s.status === 'error');
  const threshold = 0.01; // 1%
  if (providerSpans.length === 0) {
    return {
      name: 'provider_error_rate',
      description: 'Ratio of provider.completion spans with status=error',
      threshold,
      thresholdUnit: 'ratio',
      thresholdDirection: 'below',
      value: null,
      status: 'unavailable',
      samples: 0,
      reason: 'no provider.completion spans in window',
    };
  }
  const rate = errorSpans.length / providerSpans.length;
  return {
    name: 'provider_error_rate',
    description: 'Ratio of provider.completion spans with status=error',
    threshold,
    thresholdUnit: 'ratio',
    thresholdDirection: 'below',
    value: rate,
    status: rate <= threshold ? 'pass' : 'fail',
    samples: providerSpans.length,
  };
}

function computeToolErrorRate(spans: SpanRecord[]): SloResult {
  const toolSpans = spans.filter((s) => s.name === 'tool.call');
  const errorSpans = toolSpans.filter((s) => s.status === 'error');
  const threshold = 0.05; // 5%
  if (toolSpans.length === 0) {
    return {
      name: 'tool_error_rate',
      description: 'Ratio of tool.call spans with status=error',
      threshold,
      thresholdUnit: 'ratio',
      thresholdDirection: 'below',
      value: null,
      status: 'unavailable',
      samples: 0,
      reason: 'no tool.call spans in window',
    };
  }
  const rate = errorSpans.length / toolSpans.length;
  return {
    name: 'tool_error_rate',
    description: 'Ratio of tool.call spans with status=error',
    threshold,
    thresholdUnit: 'ratio',
    thresholdDirection: 'below',
    value: rate,
    status: rate <= threshold ? 'pass' : 'fail',
    samples: toolSpans.length,
  };
}

export interface EvaluateSlosOptions {
  windowDays?: number;
  rawEnv?: NodeJS.ProcessEnv;
  now?: Date;
}

export function evaluateSlos(options: EvaluateSlosOptions = {}): SloReport {
  const rawEnv = options.rawEnv ?? process.env;
  const now = options.now ?? new Date();
  // Reject non-numeric/non-finite windowDays at the API boundary so
  // `{"windowDays":"abc"}` doesn't propagate to NaN -> invalid Date ->
  // throw on toISOString. Default 7d, clamp to [1, 90] to match the MCP
  // tool input schema.
  const rawWindow = options.windowDays;
  const windowDays =
    typeof rawWindow === 'number' && Number.isFinite(rawWindow)
      ? Math.min(90, Math.max(1, Math.floor(rawWindow)))
      : 7;
  const windowStart = new Date(now.getTime() - windowDays * 24 * 60 * 60 * 1000);

  const { spans, filesScanned } = readSpansInWindow(rawEnv, windowStart);
  const slos: SloResult[] = [
    computeP99TurnLatency(spans),
    computeConfabulationRate(spans),
    computeProviderErrorRate(spans),
    computeToolErrorRate(spans),
  ];

  return {
    windowDays,
    windowStart: windowStart.toISOString(),
    windowEnd: now.toISOString(),
    spanFilesScanned: filesScanned,
    totalSamples: spans.length,
    slos,
  };
}
