/**
 * S2 operator decision 2026-05-12: memphis_repair turns excluded from
 * SLO histogram; p99 threshold tightened 30→20s.
 *
 * Test invariants:
 *   - excludeFromSlo: true is recorded in full histogram but NOT SLO one.
 *   - Default (no option) is recorded in BOTH.
 *   - Prometheus output exposes both histograms with distinct names.
 *   - SLO probe reads the SLO histogram (p99 target now '≤ 20s').
 *   - A 120s memphis_repair turn does NOT trip the SLO when normal
 *     turns are healthy.
 */
import { describe, expect, it } from 'vitest';

import { InMemoryMetrics } from '../../src/infra/logging/metrics.js';
import { checkAllSlos } from '../../src/infra/observability/slo-check.js';

describe('SLO turn-duration histogram — memphis_repair exclusion', () => {
  it('excludeFromSlo records into full histogram but not SLO histogram', () => {
    const metrics = new InMemoryMetrics();
    metrics.recordTurnDuration(120_000, { excludeFromSlo: true });

    const prom = metrics.toPrometheus();
    // Full histogram count = 1
    expect(prom).toMatch(/^turn_duration_seconds_count\s+1$/m);
    // SLO histogram count = 0 (the +Inf bucket is "0" too)
    expect(prom).toMatch(/^turn_duration_slo_seconds_count\s+0$/m);
  });

  it('default (no options) records into both histograms', () => {
    const metrics = new InMemoryMetrics();
    metrics.recordTurnDuration(5_000);
    metrics.recordTurnDuration(8_000);

    const prom = metrics.toPrometheus();
    expect(prom).toMatch(/^turn_duration_seconds_count\s+2$/m);
    expect(prom).toMatch(/^turn_duration_slo_seconds_count\s+2$/m);
  });

  it('p99 SLO target is "p99 ≤ 20s"', () => {
    const metrics = new InMemoryMetrics();
    // Need ≥ 10 samples (minSamples default).
    for (let i = 0; i < 20; i += 1) {
      metrics.recordTurnDuration(2_000);
    }
    const results = checkAllSlos(metrics);
    const p99 = results.find((r) => r.sloId === 'turn.p99');
    expect(p99?.target).toBe('p99 ≤ 20s');
    expect(p99?.ok).toBe(true);
  });

  it('a single memphis_repair-flagged 120s turn does NOT breach SLO when normal turns are healthy', () => {
    const metrics = new InMemoryMetrics();
    // 20 healthy normal turns ~ 3s each.
    for (let i = 0; i < 20; i += 1) {
      metrics.recordTurnDuration(3_000);
    }
    // One huge memphis_repair turn — flagged for exclusion.
    metrics.recordTurnDuration(120_000, { excludeFromSlo: true });

    const results = checkAllSlos(metrics);
    const p99 = results.find((r) => r.sloId === 'turn.p99');
    expect(p99?.ok).toBe(true);
    const p95 = results.find((r) => r.sloId === 'turn.p95');
    expect(p95?.ok).toBe(true);
  });

  it('SLO probe correctly fails when the SLO-scoped histogram exceeds 20s', () => {
    const metrics = new InMemoryMetrics();
    // 100 healthy turns + 5 25-second slow turns NOT excluded — 5/105
    // is ~4.7% so p99 lands in the 25s bucket.
    for (let i = 0; i < 100; i += 1) {
      metrics.recordTurnDuration(2_000);
    }
    for (let i = 0; i < 5; i += 1) {
      metrics.recordTurnDuration(25_000);
    }
    const results = checkAllSlos(metrics);
    const p99 = results.find((r) => r.sloId === 'turn.p99');
    expect(p99?.ok).toBe(false);
  });
});
