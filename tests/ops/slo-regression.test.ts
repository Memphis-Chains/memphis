/**
 * SLO regression gate.
 *
 * Closes deferred item #4. For every numbered SLO in docs/slo-baseline.md
 * there is an assertion here. Synthetic load is fed into the
 * InMemoryMetrics recorder and the gate asserts the probe reports ok.
 * The equivalent "breach" test feeds load that should trip the gate and
 * confirms the probe flags it — so both the green and red paths are
 * guarded against regressions (e.g. someone accidentally removing a
 * threshold check).
 */

import { describe, expect, it } from 'vitest';

import { InMemoryMetrics } from '../../src/infra/logging/metrics.js';
import {
  checkAllSlos,
  estimatePercentileSeconds,
} from '../../src/infra/observability/slo-check.js';

function healthyAskLoad(metrics: InMemoryMetrics, count: number, ms: number): void {
  for (let i = 0; i < count; i += 1) {
    metrics.recordHttpRequest('POST', '/v1/chat/dispatch', 200, ms);
  }
}

function healthyStatusLoad(metrics: InMemoryMetrics, count: number, ms: number): void {
  for (let i = 0; i < count; i += 1) {
    metrics.recordHttpRequest('GET', '/v1/ops/status', 200, ms);
  }
}

describe('estimatePercentileSeconds', () => {
  it('returns 0 on empty', () => {
    expect(estimatePercentileSeconds([0, 0, 0, 0], 0, 0.95)).toBe(0);
  });

  it('picks the straddling bucket for a known distribution', () => {
    // Buckets: 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10
    // All 100 samples <= 0.1s (bucket index 4), p95 should be in [0.05, 0.1].
    const buckets = [10, 20, 40, 70, 100, 100, 100, 100, 100, 100, 100];
    const p95 = estimatePercentileSeconds(buckets, 100, 0.95);
    expect(p95).toBeGreaterThan(0.05);
    expect(p95).toBeLessThanOrEqual(0.1);
  });
});

describe('SLO regression gate — healthy load passes every probe', () => {
  it('turn p95 ≤ 8s, p99 ≤ 30s with sub-second loads', () => {
    const metrics = new InMemoryMetrics();
    // 100 fast turns (~100ms) + a few slow ones just under the p99 cap
    healthyAskLoad(metrics, 100, 100);
    for (let i = 0; i < 5; i += 1) {
      metrics.recordHttpRequest('POST', '/v1/chat/dispatch', 200, 2500);
    }

    const results = checkAllSlos(metrics);
    const p95 = results.find((r) => r.sloId === 'turn.p95')!;
    const p99 = results.find((r) => r.sloId === 'turn.p99')!;

    expect(p95.ok).toBe(true);
    expect(p99.ok).toBe(true);
  });

  it('/status p95 ≤ 500ms under normal dashboard load', () => {
    const metrics = new InMemoryMetrics();
    healthyStatusLoad(metrics, 50, 50);
    healthyStatusLoad(metrics, 50, 200);

    const results = checkAllSlos(metrics);
    const status = results.find((r) => r.sloId === 'status.p95')!;
    expect(status.ok).toBe(true);
  });

  it('5xx rate ≤ 0.1% under normal traffic', () => {
    const metrics = new InMemoryMetrics();
    // 10000 successes + 1 server error → 0.01% — within budget
    for (let i = 0; i < 10000; i += 1) {
      metrics.recordHttpRequest('POST', '/v1/chat/dispatch', 200, 100);
    }
    metrics.recordHttpRequest('POST', '/v1/chat/dispatch', 500, 100);

    const results = checkAllSlos(metrics);
    const errorSlo = results.find((r) => r.sloId === 'errors.5xx-rate')!;
    expect(errorSlo.ok).toBe(true);
  });

  it('local-fallback share ≤ 10% with a healthy cascade', () => {
    const metrics = new InMemoryMetrics();
    // 95 anthropic calls + 5 local-fallback → 5% fallback share
    for (let i = 0; i < 95; i += 1) {
      metrics.recordProviderCall('anthropic', true, 150);
    }
    for (let i = 0; i < 5; i += 1) {
      metrics.recordProviderCall('local-fallback', true, 50);
    }

    const results = checkAllSlos(metrics);
    const fallback = results.find((r) => r.sloId === 'provider.local-fallback-share')!;
    expect(fallback.ok).toBe(true);
  });

  it('probes skip (ok=true) when sample count is below minSamples', () => {
    const metrics = new InMemoryMetrics();
    // Only 2 samples — below default minSamples=10 → should not fail
    metrics.recordHttpRequest('POST', '/v1/chat/dispatch', 200, 100);
    metrics.recordHttpRequest('POST', '/v1/chat/dispatch', 200, 200);

    const results = checkAllSlos(metrics);
    const p95 = results.find((r) => r.sloId === 'turn.p95')!;
    expect(p95.ok).toBe(true);
    expect(p95.detail).toMatch(/insufficient samples/);
  });
});

describe('SLO regression gate — red-path / probe detects breaches', () => {
  it('turn p95 breach trips the probe', () => {
    const metrics = new InMemoryMetrics();
    // Load that slams the p95 above the 8s cap (histogram maxes at 10s,
    // so we go beyond the last bucket and the estimator returns the
    // upper bound).
    for (let i = 0; i < 100; i += 1) {
      metrics.recordHttpRequest('POST', '/v1/chat/dispatch', 200, 9000);
    }

    const results = checkAllSlos(metrics, { minSamples: 10 });
    const p95 = results.find((r) => r.sloId === 'turn.p95')!;
    expect(p95.ok).toBe(false);
  });

  it('/status latency breach trips the probe', () => {
    const metrics = new InMemoryMetrics();
    for (let i = 0; i < 100; i += 1) {
      metrics.recordHttpRequest('GET', '/v1/ops/status', 200, 800);
    }

    const results = checkAllSlos(metrics);
    const status = results.find((r) => r.sloId === 'status.p95')!;
    expect(status.ok).toBe(false);
  });

  it('5xx rate above 0.1% trips the probe', () => {
    const metrics = new InMemoryMetrics();
    // 95 successes + 5 server errors → 5% error rate, way above 0.1%
    for (let i = 0; i < 95; i += 1) {
      metrics.recordHttpRequest('POST', '/v1/chat/dispatch', 200, 100);
    }
    for (let i = 0; i < 5; i += 1) {
      metrics.recordHttpRequest('POST', '/v1/chat/dispatch', 503, 100);
    }

    const results = checkAllSlos(metrics);
    const errorSlo = results.find((r) => r.sloId === 'errors.5xx-rate')!;
    expect(errorSlo.ok).toBe(false);
  });

  it('local-fallback dominance trips the probe', () => {
    const metrics = new InMemoryMetrics();
    for (let i = 0; i < 10; i += 1) {
      metrics.recordProviderCall('anthropic', true, 150);
    }
    // 40 local-fallback / 50 total = 80% share
    for (let i = 0; i < 40; i += 1) {
      metrics.recordProviderCall('local-fallback', true, 50);
    }

    const results = checkAllSlos(metrics);
    const fallback = results.find((r) => r.sloId === 'provider.local-fallback-share')!;
    expect(fallback.ok).toBe(false);
  });
});

describe('SLO regression gate — result shape', () => {
  it('returns one result per SLO id', () => {
    const metrics = new InMemoryMetrics();
    healthyAskLoad(metrics, 100, 100);
    healthyStatusLoad(metrics, 100, 100);
    for (let i = 0; i < 100; i += 1) {
      metrics.recordProviderCall('anthropic', true, 150);
    }

    const results = checkAllSlos(metrics);
    const ids = results.map((r) => r.sloId).sort();
    expect(ids).toEqual(
      [
        'errors.5xx-rate',
        'provider.local-fallback-share',
        'status.p95',
        'turn.p95',
        'turn.p99',
      ].sort(),
    );
    // Every result carries target + observed + ok
    for (const r of results) {
      expect(r.target).toBeTruthy();
      expect(r.observed).toBeTruthy();
      expect(typeof r.ok).toBe('boolean');
    }
  });
});
