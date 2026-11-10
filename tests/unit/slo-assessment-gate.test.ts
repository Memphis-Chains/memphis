import { describe, expect, it } from 'vitest';

import {
  assessGatedSlos,
  assessSloReport,
  REPORTED_ONLY_SLOS,
  REQUIRED_SLOS,
} from '../../src/observability/slo-assessment.js';
import type { SloReport, SloResult } from '../../src/observability/slo-evaluator.js';

// The autonomy gate weighs four metrics. A fifth one was added on
// 2026-11-10 — `p99_turn_duration_ms`, the p99 of a whole agent turn.
//
// Measured on this host: `assessSloReport` collected EVERY `fail` in
// the report, not only the four gated ones. So the new metric would
// have closed the self-modification gate on a working session that
// simply took a long time — while the SLO documentation says in plain
// words that this metric is "reported, not gated".
//
// A metric described as reported but that blocks the gate is a metric
// that lies. These tests pin the difference.

function result(name: string, status: SloResult['status']): SloResult {
  return {
    name,
    description: name,
    threshold: 1000,
    thresholdUnit: 'ms',
    thresholdDirection: 'below',
    value: status === 'pass' ? 10 : 10_000,
    status,
    samples: 10,
  };
}

function report(slos: SloResult[]): SloReport {
  return {
    windowDays: 1,
    windowStart: '2026-11-09T00:00:00.000Z',
    windowEnd: '2026-11-10T00:00:00.000Z',
    slos,
  };
}

const allGatedPassing = REQUIRED_SLOS.map((name) => result(name, 'pass'));

describe('SLO assessment · what the autonomy gate weighs', () => {
  it('fails the gate when a gated metric fails', () => {
    const slos = [...allGatedPassing, result('p99_turn_latency_ms', 'fail')];
    const assessment = assessGatedSlos(report(slos));
    expect(assessment.status).toBe('fail');
    expect(assessment.failingSlos).toContain('p99_turn_latency_ms');
  });

  it('does NOT let a reported-only metric close the gate', () => {
    const slos = [...allGatedPassing, result('p99_turn_duration_ms', 'fail')];
    const assessment = assessGatedSlos(report(slos));
    expect(assessment.failingSlos).not.toContain('p99_turn_duration_ms');
    expect(assessment.status).toBe('pass');
  });

  it('does NOT let a reported-only metric make the evidence unavailable', () => {
    const slos = [...allGatedPassing, result('p99_turn_duration_ms', 'unavailable')];
    const assessment = assessGatedSlos(report(slos));
    expect(assessment.unavailableSlos).not.toContain('p99_turn_duration_ms');
    expect(assessment.status).toBe('pass');
  });

  it('still fails the gate when a gated metric fails alongside a reported-only one', () => {
    const slos = [
      ...allGatedPassing,
      result('tool_error_rate', 'fail'),
      result('p99_turn_duration_ms', 'fail'),
    ];
    const assessment = assessGatedSlos(report(slos));
    expect(assessment.status).toBe('fail');
    expect(assessment.failingSlos).toEqual(['tool_error_rate']);
  });

  it('still REPORTS a reported-only metric in the reporting view', () => {
    // The reporting view (`assessSloReport`, used by the slo-status
    // tool) must name every metric that failed, reported-only ones
    // included. A tool that hid them would be hiding the state of the
    // system. Only the GATE ignores them.
    const slos = [...allGatedPassing, result('p99_turn_duration_ms', 'fail')];
    const reporting = assessSloReport(report(slos));
    expect(reporting.failingSlos).toContain('p99_turn_duration_ms');
    expect(reporting.status).toBe('fail');
  });

  it('names the reported-only metrics explicitly', () => {
    // An empty list would silently mean "every metric is gated" again
    // the next time a metric is added.
    expect(REPORTED_ONLY_SLOS.length).toBeGreaterThan(0);
    expect(REPORTED_ONLY_SLOS).toContain('p99_turn_duration_ms');
    for (const name of REPORTED_ONLY_SLOS) {
      expect(REQUIRED_SLOS as readonly string[]).not.toContain(name);
    }
  });
});
