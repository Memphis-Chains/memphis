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
  windowHours?: number;
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
const DEFAULT_MIN_SAMPLES = 10;

function insufficientSamples(samples: number, minSamples: number): Pick<SloResult, 'status' | 'reason'> | null {
  if (samples >= minSamples) return null;
  return {
    status: 'unavailable',
    reason: `insufficient samples (${samples} < ${minSamples})`,
  };
}

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

function readPositiveNumber(raw: string | undefined, fallback: number): number {
  if (raw === undefined || raw.trim().length === 0) return fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return parsed;
}

function computeP99TurnLatency(spans: SpanRecord[], minSamples: number, rawEnv: NodeJS.ProcessEnv): SloResult {
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
  const threshold = readPositiveNumber(rawEnv.MEMPHIS_SLO_TURN_P99_MS, 3000);
  const insufficient = insufficientSamples(latencies.length, minSamples);
  const status: SloStatus =
    p99 === null ? 'unavailable' : insufficient?.status ?? (p99 <= threshold ? 'pass' : 'fail');
  return {
    name: 'p99_turn_latency_ms',
    description: 'p99 of turn.dispatch latency over the window',
    threshold,
    thresholdUnit: 'ms',
    thresholdDirection: 'below',
    value: p99,
    status,
    samples: latencies.length,
    reason: p99 === null ? 'no turn.dispatch spans with latency in window' : insufficient?.reason,
  };
}

function computeConfabulationRate(spans: SpanRecord[], minSamples: number): SloResult {
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
  const insufficient = insufficientSamples(turnCount, minSamples);
  return {
    name: 'confabulation_rate',
    description: 'Ratio of confabulation.event to turn.dispatch over the window',
    threshold,
    thresholdUnit: 'ratio',
    thresholdDirection: 'below',
    value: rate,
    status: insufficient?.status ?? (rate <= threshold ? 'pass' : 'fail'),
    samples: turnCount,
    reason: insufficient?.reason,
  };
}

function computeProviderErrorRate(spans: SpanRecord[], minSamples: number): SloResult {
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
  const insufficient = insufficientSamples(providerSpans.length, minSamples);
  return {
    name: 'provider_error_rate',
    description: 'Ratio of provider.completion spans with status=error',
    threshold,
    thresholdUnit: 'ratio',
    thresholdDirection: 'below',
    value: rate,
    status: insufficient?.status ?? (rate <= threshold ? 'pass' : 'fail'),
    samples: providerSpans.length,
    reason: insufficient?.reason,
  };
}

function computeToolErrorRate(spans: SpanRecord[], minSamples: number): SloResult {
  const toolSpans = spans.filter((s) => s.name === 'tool.call');
  const errorSpans = toolSpans.filter(
    (s) => s.status === 'error' || s.attrs?.['tool.output.shape'] === 'error',
  );
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
  const insufficient = insufficientSamples(toolSpans.length, minSamples);
  return {
    name: 'tool_error_rate',
    description: 'Ratio of tool.call spans with status=error',
    threshold,
    thresholdUnit: 'ratio',
    thresholdDirection: 'below',
    value: rate,
    status: insufficient?.status ?? (rate <= threshold ? 'pass' : 'fail'),
    samples: toolSpans.length,
    reason: insufficient?.reason,
  };
}

export interface EvaluateSlosOptions {
  windowDays?: number;
  windowHours?: number;
  minSamples?: number;
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
  const rawWindowHours = options.windowHours;
  const windowHours =
    typeof rawWindowHours === 'number' && Number.isFinite(rawWindowHours)
      ? Math.min(90 * 24, Math.max(1, Math.floor(rawWindowHours)))
      : undefined;
  const rawWindow = options.windowDays;
  const windowDays =
    windowHours !== undefined
      ? windowHours / 24
      : typeof rawWindow === 'number' && Number.isFinite(rawWindow)
        ? Math.min(90, Math.max(1, Math.floor(rawWindow)))
        : 7;
  const minSamples =
    typeof options.minSamples === 'number' && Number.isFinite(options.minSamples)
      ? Math.max(1, Math.floor(options.minSamples))
      : DEFAULT_MIN_SAMPLES;
  const windowStart = new Date(
    now.getTime() - (windowHours ?? windowDays * 24) * 60 * 60 * 1000,
  );

  const { spans, filesScanned } = readSpansInWindow(rawEnv, windowStart);
  const slos: SloResult[] = [
    computeP99TurnLatency(spans, minSamples, rawEnv),
    computeConfabulationRate(spans, minSamples),
    computeProviderErrorRate(spans, minSamples),
    computeToolErrorRate(spans, minSamples),
  ];

  return {
    windowDays,
    windowHours,
    windowStart: windowStart.toISOString(),
    windowEnd: now.toISOString(),
    spanFilesScanned: filesScanned,
    totalSamples: spans.length,
    slos,
  };
}
