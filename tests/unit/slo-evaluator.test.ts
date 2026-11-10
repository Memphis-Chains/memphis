import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { runMemphisSloStatus } from '../../src/mcp/tools/slo-status.js';
import { evaluateSlos } from '../../src/observability/slo-evaluator.js';

interface SpanLine {
  ts: string;
  name: string;
  attrs?: Record<string, unknown>;
  durationMs?: number;
  status?: 'ok' | 'error';
}

function writeSpans(dir: string, dateStamp: string, spans: SpanLine[]): void {
  const filePath = join(dir, `spans-${dateStamp}.jsonl`);
  writeFileSync(filePath, spans.map((s) => JSON.stringify(s)).join('\n') + '\n', 'utf8');
}

describe('evaluateSlos', () => {
  let dataDir: string;
  let telemetryDir: string;
  let prevDataDir: string | undefined;
  const fixedNow = new Date('2026-04-29T12:00:00Z');

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), 'memphis-slo-test-'));
    telemetryDir = join(dataDir, 'telemetry');
    mkdirSync(telemetryDir, { recursive: true });
    prevDataDir = process.env.MEMPHIS_DATA_DIR;
    process.env.MEMPHIS_DATA_DIR = dataDir;
  });

  afterEach(() => {
    if (prevDataDir !== undefined) process.env.MEMPHIS_DATA_DIR = prevDataDir;
    else delete process.env.MEMPHIS_DATA_DIR;
    rmSync(dataDir, { recursive: true, force: true });
  });

  it('reports unavailable for every SLO when telemetry dir is empty', () => {
    const report = evaluateSlos({ now: fixedNow });
    expect(report.totalSamples).toBe(0);
    expect(report.spanFilesScanned).toBe(0);
    for (const slo of report.slos) {
      expect(slo.status).toBe('unavailable');
      expect(slo.value).toBeNull();
    }
  });

  it('does not report empty telemetry as passing through the SLO tool', () => {
    const report = runMemphisSloStatus({ windowDays: 1 }, process.env);
    expect(report.ok).toBe(true);
    expect(report.status).toBe('unavailable');
    expect(report.allSlosPassing).toBe(false);
    expect(report.failingSlos).toEqual([]);
    // Five metrics now: the four required ones plus the whole-turn
    // duration, which is reported separately from the model latency.
    expect(report.unavailableSlos).toHaveLength(5);
  });

  it('excludes future spans from both assessment and most recent activity', () => {
    const spans: SpanLine[] = Array.from({ length: 10 }, () => ({
      ts: '2026-04-29T12:00:01Z', name: 'turn.dispatch', durationMs: 1, status: 'ok',
    }));
    writeSpans(telemetryDir, '2026-04-29', spans);
    const report = evaluateSlos({ now: fixedNow });
    expect(report.totalSamples).toBe(0);
    expect(report.slos.find((slo) => slo.name === 'p99_turn_latency_ms')?.status).toBe('unavailable');
    expect(report.recent.turn).toBeNull();
  });

  it('reports stream timing separately without clearing the existing latency gate', () => {
    const spans: SpanLine[] = Array.from({ length: 10 }, () => ({
      ts: '2026-04-29T10:00:00Z', name: 'provider.completion',
      attrs: { 'provider.name': 'minimax' }, durationMs: 90000, status: 'ok',
    }));
    spans.push({
      ts: '2026-04-29T10:00:01Z', name: 'provider.completion', status: 'error',
      attrs: { 'stream.bytes': 100, 'stream.first_byte_after_headers_ms': 23, 'stream.idle_before_error_ms': 1234 },
    });
    spans.push({ ts: '2026-04-29T10:00:02Z', name: 'provider.completion', status: 'ok', attrs: {} });
    writeSpans(telemetryDir, '2026-04-29', spans);
    const report = evaluateSlos({ now: fixedNow });
    expect(report.slos.find((s) => s.name === 'p99_turn_latency_ms')?.status).toBe('fail');
    expect(report.streamDiagnostics).toEqual({
      samples: 1, firstByteAfterHeadersSamples: 1, p99FirstByteAfterHeadersMs: 23,
      idleBeforeErrorSamples: 1, maxIdleBeforeErrorMs: 1234,
    });
  });

  it('computes p99 turn latency from provider.completion spans (high p99 → fail)', () => {
    const today = '2026-04-29';
    const spans: SpanLine[] = [];
    // 50 fast + 50 slow → nearest-rank p99 lands in the slow half
    for (let i = 0; i < 50; i++) {
      spans.push({
        ts: '2026-04-29T10:00:00Z',
        name: 'provider.completion',
        attrs: { 'provider.name': 'minimax' },
        durationMs: 500,
        status: 'ok',
      });
    }
    for (let i = 0; i < 50; i++) {
      spans.push({
        ts: '2026-04-29T10:00:01Z',
        name: 'provider.completion',
        attrs: { 'provider.name': 'minimax' },
        durationMs: 9999,
        status: 'ok',
      });
    }
    writeSpans(telemetryDir, today, spans);

    const report = evaluateSlos({ now: fixedNow });
    const p99 = report.slos.find((s) => s.name === 'p99_turn_latency_ms');
    expect(p99).toBeDefined();
    expect(p99?.samples).toBe(100);
    expect(p99?.value).toBe(9999);
    expect(p99?.status).toBe('fail');
  });

  it('computes the whole-turn duration separately from the model latency', () => {
    // Measured 2026-11-10: `p99_turn_latency_ms` used to read
    // `turn.dispatch`, which covers the WHOLE agent turn. Two of the 45
    // samples were ninety-minute working sessions, so the metric measured
    // the length of the work rather than the health of the runtime — and
    // its threshold sat BELOW the median turn, so it was red by
    // construction.
    //
    // The turn duration is still measured, under the name that says what
    // it is.
    const today = '2026-04-29';
    const spans: SpanLine[] = [];
    for (let i = 0; i < 50; i++) {
      spans.push({
        ts: '2026-04-29T10:00:00Z',
        name: 'turn.dispatch',
        attrs: { 'turn.timing_ms': 500 },
        durationMs: 500,
        status: 'ok',
      });
    }
    for (let i = 0; i < 50; i++) {
      spans.push({
        ts: '2026-04-29T10:00:01Z',
        name: 'turn.dispatch',
        attrs: { 'turn.timing_ms': 9999 },
        durationMs: 9999,
        status: 'ok',
      });
    }
    writeSpans(telemetryDir, today, spans);

    const report = evaluateSlos({ now: fixedNow });
    const duration = report.slos.find((s) => s.name === 'p99_turn_duration_ms');
    expect(duration).toBeDefined();
    expect(duration?.samples).toBe(100);
    expect(duration?.value).toBe(9999);
    // The model latency has no provider.completion spans here, so it
    // cannot be measured — and missing evidence is not a pass.
    const latency = report.slos.find((s) => s.name === 'p99_turn_latency_ms');
    expect(latency?.status).toBe('unavailable');
  });

  it('computes confabulation rate as ratio to turn.dispatch', () => {
    const today = '2026-04-29';
    const spans: SpanLine[] = [];
    for (let i = 0; i < 1000; i++) {
      spans.push({
        ts: '2026-04-29T10:00:00Z',
        name: 'turn.dispatch',
        attrs: {},
        durationMs: 500,
        status: 'ok',
      });
    }
    spans.push({
      ts: '2026-04-29T10:00:00Z',
      name: 'confabulation.event',
      attrs: { 'confabulation.rule': 'a' },
      status: 'ok',
    });
    writeSpans(telemetryDir, today, spans);

    const report = evaluateSlos({ now: fixedNow });
    const confab = report.slos.find((s) => s.name === 'confabulation_rate');
    expect(confab?.value).toBe(1 / 1000);
    expect(confab?.status).toBe('pass');
  });

  it('skips spans outside the window', () => {
    writeSpans(telemetryDir, '2026-01-01', [
      {
        ts: '2026-01-01T10:00:00Z',
        name: 'provider.completion',
        durationMs: 99999,
        status: 'ok',
      },
    ]);
    writeSpans(telemetryDir, '2026-04-28', [
      {
        ts: '2026-04-28T10:00:00Z',
        name: 'provider.completion',
        attrs: { 'provider.name': 'minimax' },
        durationMs: 500,
        status: 'ok',
      },
    ]);

    // maxAgeMs: 0 disables the recency bound so this test keeps proving
    // the WINDOW filter only — the recency filter has its own test.
    const report = evaluateSlos({ now: fixedNow, windowDays: 7, maxAgeMs: 0 });
    const p99 = report.slos.find((s) => s.name === 'p99_turn_latency_ms');
    expect(p99?.samples).toBe(1);
    expect(p99?.value).toBe(500);
    expect(p99?.status).toBe('unavailable');
    expect(p99?.reason).toContain('insufficient samples');
  });

  it('evaluates only spans inside the recency bound', () => {
    const spans: SpanLine[] = [];
    // 20 fresh turns (1h old) with a healthy latency
    for (let i = 0; i < 20; i++) {
      spans.push({
        ts: '2026-04-29T11:00:00Z',
        name: 'provider.completion',
        attrs: { 'provider.name': 'minimax' },
        durationMs: 500,
        status: 'ok',
      });
    }
    // 20 stale completions (26h old) with a latency far above the threshold
    for (let i = 0; i < 20; i++) {
      spans.push({
        ts: '2026-04-28T09:00:00Z',
        name: 'provider.completion',
        attrs: { 'provider.name': 'minimax' },
        durationMs: 99000,
        status: 'ok',
      });
    }
    writeSpans(telemetryDir, '2026-04-28', spans.slice(20));
    writeSpans(telemetryDir, '2026-04-29', spans.slice(0, 20));

    const report = evaluateSlos({ now: fixedNow, windowDays: 7 });
    const p99 = report.slos.find((s) => s.name === 'p99_turn_latency_ms');
    expect(p99?.samples).toBe(20);
    expect(p99?.value).toBe(500);
    expect(p99?.status).toBe('pass');
    expect(report.sampleWindowStart).toBe('2026-04-28T12:00:00.000Z');
    expect(report.maxAgeMs).toBe(24 * 60 * 60 * 1000);
    expect(report.evaluatedSamples).toBe(20);
    expect(report.totalSamples).toBe(40);
  });

  it('reports a class that went dark instead of failing on its last sample', () => {
    // tool.call telemetry stopped three days before the report window end.
    writeSpans(telemetryDir, '2026-04-26', [
      {
        ts: '2026-04-26T09:00:00Z',
        name: 'tool.call',
        durationMs: 100,
        status: 'error',
      },
    ]);

    const report = evaluateSlos({ now: fixedNow, windowDays: 7 });
    const tool = report.slos.find((s) => s.name === 'tool_error_rate');
    expect(tool?.status).toBe('unavailable');
    expect(tool?.samples).toBe(0);
    expect(tool?.reason).toContain('no tool.call spans');
    expect(tool?.reason).toContain('last tool.call span');
    expect(tool?.lastSampleAt).toBe('2026-04-26T09:00:00Z');
    expect(tool?.ageMs).toBeGreaterThan(3 * 24 * 3600 * 1000);
  });

  it('restores window-average semantics when the recency bound is disabled', () => {
    const spans: SpanLine[] = [];
    for (let i = 0; i < 20; i++) {
      spans.push({
        ts: '2026-04-28T09:00:00Z',
        name: 'provider.completion',
        attrs: { 'provider.name': 'minimax' },
        durationMs: 99000,
        status: 'ok',
      });
    }
    writeSpans(telemetryDir, '2026-04-28', spans);

    const report = evaluateSlos({
      now: fixedNow,
      windowDays: 7,
      rawEnv: { ...process.env, MEMPHIS_SLO_MAX_AGE_MS: '0' },
    });
    const p99 = report.slos.find((s) => s.name === 'p99_turn_latency_ms');
    expect(report.maxAgeMs).toBe(0);
    expect(p99?.samples).toBe(20);
    expect(p99?.value).toBe(99000);
    expect(p99?.status).toBe('fail');
  });

  it('reports failingSlos via the wrapped tool', () => {
    const today = '2026-04-29';
    const spans: SpanLine[] = [];
    for (let i = 0; i < 100; i++) {
      spans.push({
        ts: '2026-04-29T10:00:00Z',
        name: 'provider.completion',
        attrs: { 'provider.name': 'minimax' },
        durationMs: 90000,
        status: 'ok',
      });
    }
    writeSpans(telemetryDir, today, spans);

    const report = evaluateSlos({ now: fixedNow });
    const p99 = report.slos.find((s) => s.name === 'p99_turn_latency_ms');
    expect(p99?.status).toBe('fail');
    expect(p99?.value).toBe(90000);
  });

  it('allows operator-local p99 turn latency threshold override', () => {
    const today = '2026-04-29';
    const spans: SpanLine[] = [];
    for (let i = 0; i < 100; i++) {
      spans.push({
        ts: '2026-04-29T10:00:00Z',
        name: 'provider.completion',
        attrs: { 'provider.name': 'minimax' },
        durationMs: 5000,
        status: 'ok',
      });
    }
    writeSpans(telemetryDir, today, spans);

    const report = evaluateSlos({
      now: fixedNow,
      rawEnv: { ...process.env, MEMPHIS_SLO_TURN_P99_MS: '8000' },
    });
    const p99 = report.slos.find((s) => s.name === 'p99_turn_latency_ms');
    expect(p99?.threshold).toBe(8000);
    expect(p99?.status).toBe('pass');
  });

  it('keeps slo_status tool execution ok even when SLOs fail', () => {
    const now = new Date();
    const today = now.toISOString().slice(0, 10);
    const spans: SpanLine[] = [];
    for (let i = 0; i < 100; i++) {
      spans.push({
        ts: now.toISOString(),
        name: 'provider.completion',
        attrs: { 'provider.name': 'minimax' },
        durationMs: 90000,
        status: 'ok',
      });
    }
    writeSpans(telemetryDir, today, spans);

    const report = runMemphisSloStatus({ windowDays: 7 }, process.env);
    expect(report.ok).toBe(true);
    expect(report.allSlosPassing).toBe(false);
    expect(report.failingSlos).toContain('p99_turn_latency_ms');
  });

  it('returns empty samples and unavailable when window has no spans', () => {
    writeSpans(telemetryDir, '2026-04-29', [
      {
        ts: '2026-04-29T10:00:00Z',
        name: 'tool.call',
        durationMs: 100,
        status: 'ok',
      },
    ]);

    const report = evaluateSlos({ now: fixedNow });
    const confab = report.slos.find((s) => s.name === 'confabulation_rate');
    expect(confab?.status).toBe('unavailable');
    expect(confab?.reason).toContain('no turn.dispatch');
    const tool = report.slos.find((s) => s.name === 'tool_error_rate');
    expect(tool?.status).toBe('unavailable');
    expect(tool?.value).toBe(0);
    expect(tool?.reason).toContain('insufficient samples');
  });

  it('does not mark low-sample success rates as pass', () => {
    writeSpans(telemetryDir, '2026-04-29', [
      {
        ts: '2026-04-29T10:00:00Z',
        name: 'provider.completion',
        durationMs: 100,
        status: 'ok',
      },
      {
        ts: '2026-04-29T10:00:01Z',
        name: 'provider.completion',
        durationMs: 120,
        status: 'ok',
      },
    ]);

    const report = evaluateSlos({ now: fixedNow });
    const provider = report.slos.find((s) => s.name === 'provider_error_rate');
    expect(provider?.samples).toBe(2);
    expect(provider?.value).toBe(0);
    expect(provider?.status).toBe('unavailable');
    expect(provider?.reason).toContain('insufficient samples (2 < 10)');
    expect(provider?.reason).toContain('within the last 24h');
  });

  // The runtime watch needs to know whether the LAST attempt failed, not
  // only what the window average says. One failed turn in a week keeps the
  // 7-day provider_error_rate above its threshold for seven days, which
  // reads as "the system is broken" long after it stopped being broken.
  it('reports the most recent turn, provider and tool outcome in the window', () => {
    const today = '2026-04-29';
    writeSpans(telemetryDir, today, [
      {
        ts: '2026-04-29T10:00:00Z',
        name: 'turn.dispatch',
        durationMs: 500,
        status: 'error',
      },
      {
        ts: '2026-04-29T10:00:01Z',
        name: 'provider.completion',
        durationMs: 500,
        status: 'error',
      },
      {
        ts: '2026-04-29T10:05:00Z',
        name: 'turn.dispatch',
        durationMs: 500,
        status: 'ok',
      },
      {
        ts: '2026-04-29T10:05:01Z',
        name: 'provider.completion',
        durationMs: 500,
        status: 'ok',
      },
      {
        ts: '2026-04-29T10:06:00Z',
        name: 'tool.call',
        durationMs: 50,
        status: 'ok',
      },
    ]);

    const report = evaluateSlos({ now: fixedNow });
    expect(report.recent.turn?.status).toBe('ok');
    expect(report.recent.turn?.ts).toBe('2026-04-29T10:05:00Z');
    expect(report.recent.provider?.status).toBe('ok');
    expect(report.recent.tool?.status).toBe('ok');
  });

  it('reports the last turn as failed when that is how the window ended', () => {
    const today = '2026-04-29';
    writeSpans(telemetryDir, today, [
      {
        ts: '2026-04-29T10:00:00Z',
        name: 'turn.dispatch',
        durationMs: 500,
        status: 'ok',
      },
      {
        ts: '2026-04-29T10:05:00Z',
        name: 'turn.dispatch',
        durationMs: 500,
        status: 'error',
      },
      {
        ts: '2026-04-29T10:05:01Z',
        name: 'provider.completion',
        durationMs: 500,
        status: 'error',
      },
    ]);

    const report = evaluateSlos({ now: fixedNow });
    expect(report.recent.turn?.status).toBe('error');
    expect(report.recent.provider?.status).toBe('error');
  });

  it('reports no recent activity when the window is empty', () => {
    const report = evaluateSlos({ now: fixedNow });
    expect(report.recent.turn).toBeNull();
    expect(report.recent.provider).toBeNull();
    expect(report.recent.tool).toBeNull();
  });

  it('counts tool output-shape errors as tool errors', () => {
    const spans: SpanLine[] = [];
    for (let i = 0; i < 9; i++) {
      spans.push({
        ts: '2026-04-29T10:00:00Z',
        name: 'tool.call',
        attrs: { 'tool.output.shape': 'success' },
        durationMs: 10,
        status: 'ok',
      });
    }
    spans.push({
      ts: '2026-04-29T10:00:01Z',
      name: 'tool.call',
      attrs: { 'tool.output.shape': 'error' },
      durationMs: 10,
      status: 'ok',
    });
    writeSpans(telemetryDir, '2026-04-29', spans);

    const report = evaluateSlos({ now: fixedNow });
    const tool = report.slos.find((s) => s.name === 'tool_error_rate');
    expect(tool?.samples).toBe(10);
    expect(tool?.value).toBe(0.1);
    expect(tool?.status).toBe('fail');
  });

  it('does not turn inconclusive tool outcomes into successes', () => {
    const spans: SpanLine[] = Array.from({ length: 20 }, () => ({
      ts: '2026-04-29T10:00:00Z', name: 'tool.call', durationMs: 10,
      status: 'ok' as const, attrs: { 'tool.output.shape': 'inconclusive' },
    }));
    spans.push({ ts: '2026-04-29T10:00:01Z', name: 'tool.call', durationMs: 10,
      status: 'error', attrs: { 'tool.output.shape': 'unknown' } });
    writeSpans(telemetryDir, '2026-04-29', spans);
    const tool = evaluateSlos({ now: fixedNow }).slos.find((s) => s.name === 'tool_error_rate');
    expect(tool?.samples).toBe(1);
    expect(tool?.value).toBe(1);
    expect(tool?.status).toBe('unavailable');
    expect(tool?.reason).toContain('20 tool outcome(s)');
  });

  it('reports the latest inconclusive tool outcome as unknown', () => {
    writeSpans(telemetryDir, '2026-04-29', [{
      ts: '2026-04-29T10:00:00Z', name: 'tool.call', durationMs: 10,
      status: 'ok', attrs: { 'tool.output.shape': 'inconclusive' },
    }]);
    const report = evaluateSlos({ now: fixedNow });
    expect(report.recent.tool?.status).toBe('unknown');
    expect(report.slos.find((s) => s.name === 'tool_error_rate')?.status).toBe('unavailable');
  });
});
