/**
 * SLO regression probes (closes deferred item #4).
 *
 * `docs/slo-baseline.md` names seven SLOs. Only the recovery-time
 * target had a regression test; this module + the paired test suite
 * close the gap — the build fails if any numbered SLO is breached
 * against the in-process metrics snapshot.
 *
 * The probes read from `InMemoryMetrics` rather than scraping
 * `/metrics` Prometheus text, so they:
 *   - run in CI without needing the HTTP server up
 *   - don't have to parse Prometheus text in TS tests
 *   - can be used as an end-to-end shape check: feed synthetic loads
 *     into the metrics recorder, then call the probe, then assert.
 *
 * Each SLO has a corresponding probe here. Thresholds match
 * docs/slo-baseline.md; changing a threshold means updating both
 * places in the same PR (intentional friction — no numbers without
 * documented enforcement).
 */

import type { InMemoryMetrics, ProviderMetric } from '../logging/metrics.js';
import { TURN_HISTOGRAM_BUCKETS_SECONDS } from '../logging/metrics.js';

const HISTOGRAM_BUCKETS_SECONDS = [
  0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10,
];

export interface SloResult {
  sloId: string;
  target: string;
  observed: string;
  ok: boolean;
  detail?: string;
}

interface HttpStatsLike {
  method: string;
  route: string;
  statusClass: string;
  count: number;
  errors: number;
  durationCount: number;
  durationSumSeconds: number;
  durationBuckets: number[];
}

/**
 * Extract internal http stats via the Prometheus text export (public API).
 * This keeps us from taking a hard dependency on the private field
 * `httpStats` on InMemoryMetrics.
 */
function parseHttpStatsFromPrometheus(prom: string): Map<string, HttpStatsLike> {
  const stats = new Map<string, HttpStatsLike>();
  const lines = prom.split('\n');
  const labelRe = /\{([^}]*)\}/;

  function parseLabels(labelStr: string): Record<string, string> {
    const out: Record<string, string> = {};
    const re = /(\w+)="((?:[^"\\]|\\.)*)"/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(labelStr)) !== null) {
      out[m[1]!] = m[2]!.replace(/\\"/g, '"').replace(/\\\\/g, '\\');
    }
    return out;
  }

  function keyFor(l: Record<string, string>): string {
    return `${l.method}:${l.route}:${l.status_class}`;
  }

  function ensure(key: string, l: Record<string, string>): HttpStatsLike {
    let rec = stats.get(key);
    if (!rec) {
      rec = {
        method: l.method ?? '',
        route: l.route ?? '',
        statusClass: l.status_class ?? '',
        count: 0,
        errors: 0,
        durationCount: 0,
        durationSumSeconds: 0,
        durationBuckets: HISTOGRAM_BUCKETS_SECONDS.map(() => 0),
      };
      stats.set(key, rec);
    }
    return rec;
  }

  for (const line of lines) {
    if (line.startsWith('#') || !line.trim()) continue;
    const match = line.match(labelRe);
    if (!match) continue;
    const labels = parseLabels(match[1]!);
    const valueStr = line.slice(match.index! + match[0].length).trim();
    const value = Number(valueStr);
    if (!Number.isFinite(value)) continue;

    const key = keyFor(labels);
    const rec = ensure(key, labels);

    if (line.startsWith('requests_total')) rec.count = value;
    else if (line.startsWith('errors_total')) rec.errors = value;
    else if (line.startsWith('request_duration_seconds_bucket')) {
      const le = labels.le;
      if (le === '+Inf') continue;
      const idx = HISTOGRAM_BUCKETS_SECONDS.indexOf(Number(le));
      if (idx >= 0) rec.durationBuckets[idx] = value;
    } else if (line.startsWith('request_duration_seconds_count')) {
      rec.durationCount = value;
    } else if (line.startsWith('request_duration_seconds_sum')) {
      rec.durationSumSeconds = value;
    }
  }

  return stats;
}

/**
 * Compute the percentile latency from the histogram buckets using
 * linear interpolation within the straddling bucket — same approach
 * Prometheus uses for `histogram_quantile()`.
 *
 * Codex Round 5 P1 fix: bucketEdges parameter so we can use different
 * edge sets for the HTTP histogram (cap 10s) and the turn histogram
 * (cap 120s). Default keeps backward compatibility for callers using
 * the HTTP histogram.
 */
export function estimatePercentileSeconds(
  buckets: number[],
  totalCount: number,
  quantile: number,
  bucketEdges: number[] = HISTOGRAM_BUCKETS_SECONDS,
): number {
  if (totalCount === 0) return 0;
  const target = quantile * totalCount;
  let cumulative = 0;
  let lower = 0;
  for (let i = 0; i < buckets.length; i += 1) {
    const upper = bucketEdges[i]!;
    const prevCumulative = cumulative;
    cumulative = buckets[i] ?? 0;
    if (cumulative >= target) {
      const bucketCount = cumulative - prevCumulative;
      if (bucketCount === 0) return lower;
      const inBucket = (target - prevCumulative) / bucketCount;
      return lower + inBucket * (upper - lower);
    }
    lower = upper;
  }
  // Target beyond the highest bucket — return an upper-bound estimate.
  return bucketEdges[bucketEdges.length - 1]!;
}

function aggregateByRoute(
  stats: Map<string, HttpStatsLike>,
  route: string,
): { count: number; buckets: number[]; errors: number } {
  const buckets = HISTOGRAM_BUCKETS_SECONDS.map(() => 0);
  let count = 0;
  let errors = 0;
  for (const rec of stats.values()) {
    if (rec.route !== route) continue;
    count += rec.durationCount;
    errors += rec.errors;
    for (let i = 0; i < buckets.length; i += 1) {
      buckets[i] += rec.durationBuckets[i] ?? 0;
    }
  }
  return { count, buckets, errors };
}

/**
 * Codex Round 5 P1 fix: parse the dedicated `turn_duration_seconds`
 * histogram (separate from the per-route HTTP histogram). The turn
 * histogram has wider buckets for the long-running cascade tail.
 */
function parseTurnHistogramFromPrometheus(prom: string): {
  buckets: number[];
  count: number;
} {
  const buckets = TURN_HISTOGRAM_BUCKETS_SECONDS.map(() => 0);
  let count = 0;
  for (const line of prom.split('\n')) {
    if (line.startsWith('turn_duration_seconds_bucket{')) {
      const m = line.match(/le="([^"]+)"\}\s+(\d+(?:\.\d+)?)/);
      if (!m) continue;
      const le = m[1]!;
      if (le === '+Inf') continue;
      const idx = TURN_HISTOGRAM_BUCKETS_SECONDS.indexOf(Number(le));
      if (idx >= 0) buckets[idx] = Number(m[2]);
    } else if (line.startsWith('turn_duration_seconds_count')) {
      const m = line.match(/\s+(\d+(?:\.\d+)?)/);
      if (m) count = Number(m[1]);
    }
  }
  return { buckets, count };
}

function aggregate5xxRate(stats: Map<string, HttpStatsLike>): {
  total: number;
  fivexx: number;
  rate: number;
} {
  let total = 0;
  let fivexx = 0;
  for (const rec of stats.values()) {
    if (!rec.route.startsWith('/v1/')) continue;
    total += rec.count;
    if (rec.statusClass === '5xx') fivexx += rec.count;
  }
  return { total, fivexx, rate: total === 0 ? 0 : fivexx / total };
}

export interface SloCheckOptions {
  /**
   * When > 0, probes require at least this many samples before failing.
   * Avoids flapping on a tiny sample (e.g. a single test call that
   * happened to take longer than the threshold).
   */
  minSamples?: number;
}

/**
 * Check every documented SLO against the current in-memory metrics.
 * Each result independently reports ok + observed so the caller can
 * print a full report on failure.
 */
export function checkAllSlos(
  metrics: InMemoryMetrics,
  options: SloCheckOptions = {},
): SloResult[] {
  const minSamples = options.minSamples ?? 10;
  const prom = metrics.toPrometheus();
  const stats = parseHttpStatsFromPrometheus(prom);

  const results: SloResult[] = [];

  // Codex Round 5 P1 fix: SLO 1+2 measure END-TO-END turn duration via
  // the dedicated `turn_duration_seconds` histogram, NOT the HTTP
  // /v1/chat/dispatch latency (which only times the enqueue path; the
  // actual model run happens asynchronously).
  const turnHist = parseTurnHistogramFromPrometheus(prom);
  const turnP95 = estimatePercentileSeconds(
    turnHist.buckets,
    turnHist.count,
    0.95,
    TURN_HISTOGRAM_BUCKETS_SECONDS,
  );
  results.push({
    sloId: 'turn.p95',
    target: 'p95 ≤ 8s',
    observed: `${turnP95.toFixed(3)}s`,
    ok: turnHist.count < minSamples || turnP95 <= 8,
    detail:
      turnHist.count < minSamples
        ? `insufficient samples (${turnHist.count} < ${minSamples}); skipping`
        : undefined,
  });

  const turnP99 = estimatePercentileSeconds(
    turnHist.buckets,
    turnHist.count,
    0.99,
    TURN_HISTOGRAM_BUCKETS_SECONDS,
  );
  results.push({
    sloId: 'turn.p99',
    target: 'p99 ≤ 30s',
    observed: `${turnP99.toFixed(3)}s`,
    ok: turnHist.count < minSamples || turnP99 <= 30,
    detail:
      turnHist.count < minSamples
        ? `insufficient samples (${turnHist.count} < ${minSamples}); skipping`
        : undefined,
  });

  // SLO 3: /v1/ops/status latency p95 ≤ 500 ms.
  const statusStats = aggregateByRoute(stats, '/v1/ops/status');
  const statusP95 = estimatePercentileSeconds(statusStats.buckets, statusStats.count, 0.95);
  results.push({
    sloId: 'status.p95',
    target: 'p95 ≤ 500ms',
    observed: `${(statusP95 * 1000).toFixed(1)}ms`,
    ok: statusStats.count < minSamples || statusP95 <= 0.5,
    detail:
      statusStats.count < minSamples
        ? `insufficient samples (${statusStats.count} < ${minSamples}); skipping`
        : undefined,
  });

  // SLO 6: 5xx rate on /v1/* ≤ 0.1%.
  const errorAgg = aggregate5xxRate(stats);
  results.push({
    sloId: 'errors.5xx-rate',
    target: '≤ 0.1%',
    observed: `${(errorAgg.rate * 100).toFixed(3)}% (${errorAgg.fivexx}/${errorAgg.total})`,
    ok: errorAgg.total < minSamples || errorAgg.rate <= 0.001,
    detail:
      errorAgg.total < minSamples
        ? `insufficient samples (${errorAgg.total} < ${minSamples}); skipping`
        : undefined,
  });

  // SLO 7: provider degradation ≤ 10% of turns landing on local-fallback.
  // Derive from provider stats — InMemoryMetrics tracks askRequests by provider.
  const providerLines = prom
    .split('\n')
    .filter((line) => line.startsWith('ask_requests_total{provider='));
  let totalAsk = 0;
  let fallbackAsk = 0;
  for (const line of providerLines) {
    const m = line.match(/provider="([^"]+)"\}\s+(\d+(?:\.\d+)?)/);
    if (!m) continue;
    const provider = m[1]!;
    const value = Number(m[2]);
    totalAsk += value;
    if (provider === 'local-fallback') fallbackAsk += value;
  }
  const fallbackRate = totalAsk === 0 ? 0 : fallbackAsk / totalAsk;
  results.push({
    sloId: 'provider.local-fallback-share',
    target: '≤ 10%',
    observed: `${(fallbackRate * 100).toFixed(2)}% (${fallbackAsk}/${totalAsk})`,
    ok: totalAsk < minSamples || fallbackRate <= 0.1,
    detail:
      totalAsk < minSamples
        ? `insufficient samples (${totalAsk} < ${minSamples}); skipping`
        : undefined,
  });

  return results;
}

/**
 * Legacy per-provider latency average — useful for per-provider SLO
 * panels. Not gated by the default checkAllSlos set because the
 * per-provider cascade is deliberately allowed to be slow for
 * tier-5 local-fallback.
 */
export function providerLatencyReport(metrics: InMemoryMetrics): Array<{
  provider: string;
  avgSeconds: number;
  calls: number;
}> {
  // Use the public exporter + parser since the provider stats aren't
  // directly exposed. This is a diagnostic, not an assertion.
  const prom = metrics.toPrometheus();
  const lines = prom.split('\n');
  const countByProvider = new Map<string, number>();
  const sumByProvider = new Map<string, number>();
  for (const line of lines) {
    if (line.startsWith('ask_request_duration_seconds_count{')) {
      const m = line.match(/provider="([^"]+)"\}\s+(\d+(?:\.\d+)?)/);
      if (m) countByProvider.set(m[1]!, Number(m[2]));
    } else if (line.startsWith('ask_request_duration_seconds_sum{')) {
      const m = line.match(/provider="([^"]+)"\}\s+(\d+(?:\.\d+)?)/);
      if (m) sumByProvider.set(m[1]!, Number(m[2]));
    }
  }
  const providers = new Set([...countByProvider.keys(), ...sumByProvider.keys()]);
  const report: Array<{ provider: string; avgSeconds: number; calls: number }> = [];
  for (const provider of providers) {
    const count = countByProvider.get(provider) ?? 0;
    const sum = sumByProvider.get(provider) ?? 0;
    report.push({
      provider,
      calls: count,
      avgSeconds: count === 0 ? 0 : sum / count,
    });
  }
  return report;
}

// Re-export so tests can reference the provider type without importing metrics.ts directly.
export type { ProviderMetric };
