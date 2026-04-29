import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

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

  it('computes p99 turn latency from turn.dispatch spans (high p99 → fail)', () => {
    const today = '2026-04-29';
    const spans: SpanLine[] = [];
    // 50 fast + 50 slow → nearest-rank p99 lands in the slow half
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
    const p99 = report.slos.find((s) => s.name === 'p99_turn_latency_ms');
    expect(p99).toBeDefined();
    expect(p99?.samples).toBe(100);
    expect(p99?.value).toBe(9999);
    expect(p99?.status).toBe('fail');
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
        name: 'turn.dispatch',
        durationMs: 99999,
        status: 'ok',
      },
    ]);
    writeSpans(telemetryDir, '2026-04-28', [
      {
        ts: '2026-04-28T10:00:00Z',
        name: 'turn.dispatch',
        attrs: { 'turn.timing_ms': 500 },
        durationMs: 500,
        status: 'ok',
      },
    ]);

    const report = evaluateSlos({ now: fixedNow, windowDays: 7 });
    const p99 = report.slos.find((s) => s.name === 'p99_turn_latency_ms');
    expect(p99?.samples).toBe(1);
    expect(p99?.value).toBe(500);
    expect(p99?.status).toBe('pass');
  });

  it('reports failingSlos via the wrapped tool', () => {
    const today = '2026-04-29';
    const spans: SpanLine[] = [];
    for (let i = 0; i < 100; i++) {
      spans.push({
        ts: '2026-04-29T10:00:00Z',
        name: 'turn.dispatch',
        durationMs: 5000,
        status: 'ok',
      });
    }
    writeSpans(telemetryDir, today, spans);

    const report = evaluateSlos({ now: fixedNow });
    const p99 = report.slos.find((s) => s.name === 'p99_turn_latency_ms');
    expect(p99?.status).toBe('fail');
    expect(p99?.value).toBe(5000);
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
    expect(tool?.status).toBe('pass');
    expect(tool?.value).toBe(0);
  });
});
