import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

import { getDataDir } from '../config/paths.js';
import { readSinkStatusEntries, type SinkStatusEntry } from '../infra/observability/sink-status.js';

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
  /**
   * Newest span of this SLO's class inside the requested window.
   *
   * `ageMs` says how old that evidence is. A report that says "fail"
   * without saying "that evidence is four days old" is exactly how a
   * stale breach keeps looking like a current one.
   */
  lastSampleAt?: string;
  ageMs?: number;
}

/**
 * The most recent span of one kind inside the window.
 *
 * The window average answers "how have the last days been going"; this
 * answers "how did the last attempt go". The runtime watch needs the
 * second one: one failed turn in a week keeps the 7-day error rate above
 * its threshold for seven days, which reads as a broken system long after
 * it stopped being broken.
 */
export interface RecentActivityEntry {
  /** When the span happened. */
  ts: string;
  /** How it ended. */
  status: 'ok' | 'error' | 'unknown';
}

export interface RecentActivity {
  /** The last `turn.dispatch` in the window. */
  turn: RecentActivityEntry | null;
  /** The last `provider.completion` in the window. */
  provider: RecentActivityEntry | null;
  /** The last `tool.call` in the window. */
  tool: RecentActivityEntry | null;
}

export interface SloReport {
  windowDays: number;
  windowHours?: number;
  windowStart: string;
  windowEnd: string;
  /**
   * Start of the population actually evaluated.
   *
   * The requested window is `windowStart..windowEnd`; the evaluated
   * population is that window intersected with the recency bound
   * (`maxAgeMs`). A 7-day request with the default 24h bound evaluates
   * the last 24h of evidence and says so here.
   */
  sampleWindowStart: string;
  /** Supplemental stream observations; these do not relax the SLO gate. */
  streamDiagnostics?: {
    samples: number;
    firstByteAfterHeadersSamples: number;
    p99FirstByteAfterHeadersMs: number | null;
    idleBeforeErrorSamples: number;
    maxIdleBeforeErrorMs: number | null;
  };
  /** Recency bound applied to samples, in ms. 0 = unbounded. */
  maxAgeMs: number;
  /** Spans inside the evaluated population (window ∩ recency bound). */
  evaluatedSamples: number;
  spanFilesScanned: number;
  totalSamples: number;
  slos: SloResult[];
  /** How the most recent attempts in the window ended. */
  recent: RecentActivity;
  /**
   * The state of the local span sinks that feed this report.
   *
   * A sink that cannot write and a runtime that is idle both produce no
   * spans. Without this field the report cannot tell them apart, and a
   * broken sink reads as "nothing happened" — which is how the missing
   * `tool.call` spans of 2026-10-26 stayed invisible for days.
   */
  sinkStatus: SinkStatusEntry[];
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

/**
 * Default recency bound for evaluated samples: 24h.
 *
 * WHY A BOUND AT ALL
 * ------------------
 * Measured on this host (2026-10-29): every failing SLO in the 7-day
 * window was decided by evidence from 2026-10-25 — one 34-minute
 * Telegram turn, one confabulation event, and a tool-error rate
 * computed from `tool.call` spans that stopped being emitted on
 * 2026-10-26. The report said "fail" every day for a runtime that had
 * no current tool telemetry at all.
 *
 * The bound says: an SLO describes the CURRENT state of the runtime.
 * Evidence older than the bound is still read (so the report can say
 * "last tool.call 3 days ago"), but it does not decide pass/fail.
 *
 * `MEMPHIS_SLO_MAX_AGE_MS=0` disables the bound and restores the
 * window-average semantics; a larger value widens the horizon.
 */
const DEFAULT_MAX_SAMPLE_AGE_MS = 24 * 60 * 60 * 1000;

/** Span class behind each SLO name — used for freshness reporting. */
const SLO_CLASS_SPANS: Record<string, string> = {
  p99_turn_latency_ms: 'provider.completion',
  confabulation_rate: 'turn.dispatch',
  provider_error_rate: 'provider.completion',
  p99_turn_duration_ms: 'turn.dispatch',
  tool_error_rate: 'tool.call',
};

function resolveMaxAgeMs(explicit: number | undefined, rawEnv: NodeJS.ProcessEnv): number {
  if (typeof explicit === 'number' && Number.isFinite(explicit)) {
    return explicit < 0 ? 0 : Math.floor(explicit);
  }
  const raw = rawEnv.MEMPHIS_SLO_MAX_AGE_MS;
  if (raw === undefined || raw.trim().length === 0) return DEFAULT_MAX_SAMPLE_AGE_MS;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 0) return DEFAULT_MAX_SAMPLE_AGE_MS;
  return Math.floor(parsed);
}

function newestSpanTs(spans: SpanRecord[]): string | undefined {
  let best: string | undefined;
  let bestMs = Number.NEGATIVE_INFINITY;
  for (const span of spans) {
    const ms = Date.parse(span.ts);
    if (!Number.isFinite(ms)) continue;
    if (ms > bestMs) {
      bestMs = ms;
      best = span.ts;
    }
  }
  return best;
}

function formatAge(ms: number): string {
  const minutes = Math.round(ms / 60000);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours}h`;
  return `${Math.round(hours / 24)}d`;
}

function insufficientSamples(
  samples: number,
  minSamples: number,
): Pick<SloResult, 'status' | 'reason'> | null {
  if (samples >= minSamples) return null;
  return {
    status: 'unavailable',
    reason: `insufficient samples (${samples} < ${minSamples})`,
  };
}

function readSpansInWindow(
  rawEnv: NodeJS.ProcessEnv,
  windowStart: Date,
  windowEnd: Date,
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
      if (Number.isNaN(tsMs) || tsMs < startMs || tsMs > windowEnd.getTime()) continue;
      spans.push(parsed);
    }
  }
  return { spans, filesScanned };
}

/**
 * The most recent span of each kind in the window.
 *
 * The spans arrive in file order, which is chronological within a day but
 * not across days, so the newest one is found by timestamp rather than by
 * position.
 */
function readRecentActivity(spans: SpanRecord[]): RecentActivity {
  const latest = (name: string): RecentActivityEntry | null => {
    let best: SpanRecord | undefined;
    for (const span of spans) {
      if (span.name !== name) continue;
      if (!best || Date.parse(span.ts) >= Date.parse(best.ts)) best = span;
    }
    if (!best) return null;
    const shape = name === 'tool.call' ? best.attrs?.['tool.output.shape'] : undefined;
    const status = best.status === 'error' || shape === 'error' ? 'error'
      : shape === 'inconclusive' || shape === 'unknown' ? 'unknown' : 'ok';
    return { ts: best.ts, status };
  };
  return {
    turn: latest('turn.dispatch'),
    provider: latest('provider.completion'),
    tool: latest('tool.call'),
  };
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

/**
 * p99 of how long the operator waited for the model.
 *
 * THE SPAN CHANGED, AND HERE IS WHY
 * ---------------------------------
 * This metric used to be computed from `turn.dispatch`, which covers the
 * WHOLE agent turn — from the operator's prompt through every tool call
 * to the last one. Measured on this host, 2026-11-10, over the 7-day
 * window: n=45, p50=161 162 ms, p99=5 956 858 ms. Two of the 45 samples
 * were ninety-minute working sessions of this agent's own, so the p99
 * measured the LENGTH OF THE WORK, not the health of the runtime. The
 * threshold was 90 s, which is below the median turn of 161 s, so the
 * metric was red by construction and blocked self-modification on every
 * run regardless of what the system was doing.
 *
 * It is now computed from `provider.completion` — one model call — which
 * is what "turn latency" means to the person waiting: how long until
 * the model answered. The name, the threshold variable and the public
 * contract are unchanged; what the number measures is what it says.
 *
 * The whole-turn duration is still measured and still reported, under
 * the name `p99_turn_duration_ms`. `confabulation_rate` still reads
 * `turn.dispatch`, because the rate of confabulation needs the whole
 * turn to be judged.
 */
function computeP99TurnLatency(
  spans: SpanRecord[],
  minSamples: number,
  rawEnv: NodeJS.ProcessEnv,
): SloResult {
  const providerSpans = spans.filter((s) => s.name === 'provider.completion');
  const latencies: number[] = [];
  for (const s of providerSpans) {
    const v = s.durationMs;
    if (typeof v === 'number' && Number.isFinite(v) && v >= 0) latencies.push(v);
  }
  const p99 = percentile(latencies, 99);
  const threshold = readPositiveNumber(rawEnv.MEMPHIS_SLO_TURN_P99_MS, 60_000);
  const insufficient = insufficientSamples(latencies.length, minSamples);
  const status: SloStatus =
    p99 === null ? 'unavailable' : (insufficient?.status ?? (p99 <= threshold ? 'pass' : 'fail'));
  return {
    name: 'p99_turn_latency_ms',
    description: 'p99 of provider.completion latency over the window',
    threshold,
    thresholdUnit: 'ms',
    thresholdDirection: 'below',
    value: p99,
    status,
    samples: latencies.length,
    reason:
      p99 === null ? 'no provider.completion spans with latency in window' : insufficient?.reason,
  };
}

/**
 * p99 of the WHOLE agent turn — every tool call included.
 *
 * This is the duration the old `p99_turn_latency_ms` measured, kept
 * under a name that says what it is. Measured on this host, 2026-11-10,
 * over the 7-day window: n=45, p50=161 162 ms, p95=2 132 850 ms,
 * p99=5 956 858 ms. Two of the 45 samples were ninety-minute working
 * sessions of this agent's own.
 *
 * It is reported, not gated. A turn's duration is the length of the work
 * the operator asked for — an hour of real work is not a fault — so a
 * threshold over it says nothing about the health of the runtime. The
 * threshold is set above the longest turn ever measured here, which
 * makes the metric a HANG DETECTOR: a turn that exceeds it is a turn
 * that did not finish.
 */
function computeP99TurnDuration(
  spans: SpanRecord[],
  minSamples: number,
  rawEnv: NodeJS.ProcessEnv,
): SloResult {
  const turnSpans = spans.filter((s) => s.name === 'turn.dispatch');
  const latencies: number[] = [];
  for (const s of turnSpans) {
    const fromAttr = s.attrs?.['turn.timing_ms'];
    const fromDuration = s.durationMs;
    const v =
      typeof fromAttr === 'number'
        ? fromAttr
        : typeof fromDuration === 'number'
          ? fromDuration
          : null;
    if (typeof v === 'number' && Number.isFinite(v) && v >= 0) latencies.push(v);
  }
  const p99 = percentile(latencies, 99);
  const threshold = readPositiveNumber(rawEnv.MEMPHIS_SLO_TURN_DURATION_P99_MS, 7_200_000);
  const insufficient = insufficientSamples(latencies.length, minSamples);
  const status: SloStatus =
    p99 === null ? 'unavailable' : (insufficient?.status ?? (p99 <= threshold ? 'pass' : 'fail'));
  return {
    name: 'p99_turn_duration_ms',
    description: 'p99 of whole-turn duration over the window (every tool call included)',
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
  // An inconclusive result is not evidence of success. Keep explicit
  // transport errors, but exclude unknown outcomes from the denominator.
  const classified = toolSpans.filter((s) => s.status === 'error' ||
    (s.attrs?.['tool.output.shape'] !== 'inconclusive' && s.attrs?.['tool.output.shape'] !== 'unknown'));
  const excluded = toolSpans.length - classified.length;
  const errorSpans = classified.filter(
    (s) => s.status === 'error' || s.attrs?.['tool.output.shape'] === 'error',
  );
  const threshold = 0.05; // 5%
  if (classified.length === 0) {
    return {
      name: 'tool_error_rate',
      description: 'Ratio of tool.call spans with status=error',
      threshold,
      thresholdUnit: 'ratio',
      thresholdDirection: 'below',
      value: null,
      status: 'unavailable',
      samples: 0,
      reason: excluded ? `${excluded} tool outcome(s) inconclusive or unknown` : 'no tool.call spans in window',
    };
  }
  const rate = errorSpans.length / classified.length;
  const insufficient = insufficientSamples(classified.length, minSamples);
  return {
    name: 'tool_error_rate',
    description: 'Ratio of tool.call spans with status=error',
    threshold,
    thresholdUnit: 'ratio',
    thresholdDirection: 'below',
    value: rate,
    status: insufficient?.status ?? (rate <= threshold ? 'pass' : 'fail'),
    samples: classified.length,
    reason: [insufficient?.reason, excluded ? `${excluded} tool outcome(s) inconclusive or unknown` : undefined].filter(Boolean).join('; ') || undefined,
  };
}

export interface EvaluateSlosOptions {
  windowDays?: number;
  windowHours?: number;
  minSamples?: number;
  /**
   * Recency bound for evaluated samples, in milliseconds.
   *
   * 0 disables the bound and restores the window-average semantics.
   * Defaults to `MEMPHIS_SLO_MAX_AGE_MS`, then to 24h.
   */
  maxAgeMs?: number;
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
  const windowStart = new Date(now.getTime() - (windowHours ?? windowDays * 24) * 60 * 60 * 1000);
  const maxAgeMs = resolveMaxAgeMs(options.maxAgeMs, rawEnv);
  // The evaluated population is the requested window intersected with the
  // recency bound. Older spans are still READ (so the report can name the
  // last time a class was seen) but they do not decide pass/fail.
  const sampleWindowStartMs =
    maxAgeMs > 0
      ? Math.max(windowStart.getTime(), now.getTime() - maxAgeMs)
      : windowStart.getTime();
  const sampleWindowStart = new Date(sampleWindowStartMs);

  const { spans, filesScanned } = readSpansInWindow(rawEnv, windowStart, now);
  const sinkStatus = readSinkStatusEntries(getDataDir(rawEnv));
  const evaluated = spans.filter((span) => Date.parse(span.ts) >= sampleWindowStartMs);
  const providerSpans = evaluated.filter((span) => span.name === 'provider.completion');
  const numericAttr = (name: string): number[] => providerSpans
    .map((span) => span.attrs?.[name])
    .filter((value): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0);
  const firstBytes = numericAttr('stream.first_byte_after_headers_ms');
  const errorIdle = providerSpans.filter((span) => span.status === 'error')
    .map((span) => span.attrs?.['stream.idle_before_error_ms'])
    .filter((value): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0);
  const slos: SloResult[] = [
    computeP99TurnLatency(evaluated, minSamples, rawEnv),
    computeConfabulationRate(evaluated, minSamples),
    computeProviderErrorRate(evaluated, minSamples),
    computeP99TurnDuration(evaluated, minSamples, rawEnv),
    computeToolErrorRate(evaluated, minSamples),
  ];

  // Freshness and reasons. Without this the report says "fail" for
  // evidence that is days old, and says nothing when the only evidence
  // is "this class has not been seen since 3 days ago".
  const boundHours = Math.round(maxAgeMs / 3600000);
  for (const slo of slos) {
    const className = SLO_CLASS_SPANS[slo.name];
    if (!className) continue;
    const newest = newestSpanTs(spans.filter((span) => span.name === className));
    if (newest) {
      slo.lastSampleAt = newest;
      slo.ageMs = Math.max(0, now.getTime() - Date.parse(newest));
    }
    if (slo.status !== 'unavailable') continue;
    if (maxAgeMs > 0 && slo.reason?.startsWith('insufficient samples')) {
      slo.reason = `${slo.reason} within the last ${boundHours}h`;
    }
    if (slo.samples === 0 && newest && maxAgeMs > 0) {
      const age = formatAge(now.getTime() - Date.parse(newest));
      slo.reason = `${slo.reason ?? 'no samples'} - last ${className} span ${age} ago`;
    }
    // A degraded sink explains the absence of spans better than silence
    // does. The operator learns that the measurement broke, not that the
    // runtime was idle.
    if (slo.samples === 0) {
      const degraded = sinkStatus.filter((entry) => entry.state === 'degraded');
      if (degraded.length > 0) {
        const detail = degraded
          .map((entry) => `${entry.surface}${entry.lastError ? `: ${entry.lastError}` : ''}`)
          .join(', ');
        slo.reason = `${slo.reason ?? 'no samples'} - the local span sink is degraded (${detail})`;
      }
    }
  }

  return {
    windowDays,
    windowHours,
    windowStart: windowStart.toISOString(),
    windowEnd: now.toISOString(),
    sampleWindowStart: sampleWindowStart.toISOString(),
    streamDiagnostics: {
      samples: providerSpans.filter((span) => typeof span.attrs?.['stream.bytes'] === 'number').length,
      firstByteAfterHeadersSamples: firstBytes.length,
      p99FirstByteAfterHeadersMs: percentile(firstBytes, 99),
      idleBeforeErrorSamples: errorIdle.length,
      maxIdleBeforeErrorMs: errorIdle.length > 0 ? errorIdle.reduce((max, value) => Math.max(max, value), 0) : null,
    },
    maxAgeMs,
    evaluatedSamples: evaluated.length,
    spanFilesScanned: filesScanned,
    totalSamples: spans.length,
    slos,
    recent: readRecentActivity(spans),
    sinkStatus,
  };
}
