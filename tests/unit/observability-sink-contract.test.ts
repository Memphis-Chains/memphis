/**
 * The two local span sinks must answer the same.
 *
 * `tests/fixtures/telemetry-sink-status-contract.json` holds the contract;
 * the Rust runner is `crates/memphis-operator/tests/sink_contract.rs`.
 *
 * WHY THE CONTRACT EXISTS
 * -----------------------
 * The two arms used to disable their sink permanently after the first
 * write failure, and they did it independently — the TypeScript side with
 * a `writeFailedOnce` flag, the native side with a `WRITE_FAILED_ONCE`
 * atomic. Both were silent apart from one line on stderr, and a broken
 * sink looked exactly like an idle runtime: no spans either way.
 *
 * The contract pins three things that must not drift:
 *   - the status file shape, so the report reads either arm;
 *   - the retry schedule, so both arms back off identically;
 *   - the recovery rule, so a sink that failed comes back on its own.
 */

import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import type { AppConfig } from '../../src/infra/config/schema.js';
import { buildHealthPayload } from '../../src/infra/http/health.js';
import {
  getLocalSinkRetryState,
  recordLocalSpan,
  __resetLocalSinkForTests,
} from '../../src/infra/observability/console-exporter.js';
import {
  sinkRetryDelayMs,
  sinkRecordFailure,
  sinkRecordSuccess,
  type SinkRetryState,
} from '../../src/infra/observability/sink-retry.js';
import {
  readSinkStatusEntries,
  sinkStatusFileName,
  writeSinkStatus,
  type SinkStatusEntry,
} from '../../src/infra/observability/sink-status.js';
import { evaluateSlos } from '../../src/observability/slo-evaluator.js';

const FIXTURE_PATH = path.join(__dirname, '..', 'fixtures', 'telemetry-sink-status-contract.json');

interface Contract {
  statusFile: {
    namePattern: string;
    fields: string[];
    states: string[];
    surfaces: string[];
  };
  retry: {
    baseMs: number;
    multiplier: number;
    maxMs: number;
    schedule: Array<{ consecutiveFailures: number; delayMs: number }>;
  };
}

function readContract(): Contract {
  return JSON.parse(readFileSync(FIXTURE_PATH, 'utf8')) as Contract;
}

function tempDir(prefix: string): string {
  return mkdtempSync(path.join(tmpdir(), `${prefix}-`));
}

describe('the local span sink contract', () => {
  it('the fixture is the contract both arms read', () => {
    const contract = readContract();
    expect(contract.statusFile.fields.length).toBeGreaterThan(0);
    expect(contract.retry.schedule.length).toBeGreaterThan(0);
    // A contract file with no schedule would let both arms drift.
    expect(contract.retry.schedule[0]?.consecutiveFailures).toBe(0);
  });

  it('the retry schedule matches the contract', () => {
    const contract = readContract();
    for (const entry of contract.retry.schedule) {
      expect(
        sinkRetryDelayMs(entry.consecutiveFailures, contract.retry.baseMs, contract.retry.maxMs),
      ).toBe(entry.delayMs);
    }
  });

  it('the base delay and the cap come from the contract', () => {
    const contract = readContract();
    expect(sinkRetryDelayMs(1)).toBe(contract.retry.baseMs);
    expect(sinkRetryDelayMs(50)).toBe(contract.retry.maxMs);
  });

  it('a failed write does not disable the sink forever', () => {
    let state: SinkRetryState = sinkRecordSuccess(
      {
        consecutiveFailures: 0,
        nextAttemptAtMs: null,
        lastError: null,
        lastFailureAtMs: null,
        lastSuccessAtMs: null,
      },
      1_000,
    );
    state = sinkRecordFailure(state, 2_000, 'disk full');
    expect(state.consecutiveFailures).toBe(1);
    expect(state.lastError).toBe('disk full');
    // The failure schedules the next attempt; it does not close it.
    expect(state.nextAttemptAtMs).toBe(2_000 + sinkRetryDelayMs(1));

    state = sinkRecordSuccess(state, 10_000);
    expect(state.consecutiveFailures).toBe(0);
    expect(state.nextAttemptAtMs).toBeNull();
    expect(state.lastError).toBeNull();
    expect(state.lastSuccessAtMs).toBe(10_000);
  });

  it('the status file carries every field of the contract', () => {
    const contract = readContract();
    const dir = tempDir('memphis-sink-status-contract');
    try {
      const entry: SinkStatusEntry = {
        surface: 'ts',
        state: 'degraded',
        consecutiveFailures: 2,
        lastError: 'EACCES',
        lastFailureAt: '2026-11-01T10:00:00.000Z',
        lastSuccessAt: '2026-11-01T09:00:00.000Z',
        nextRetryAt: '2026-11-01T10:00:02.000Z',
        updatedAt: '2026-11-01T10:00:00.000Z',
      };
      writeSinkStatus(dir, entry);
      const file = path.join(dir, sinkStatusFileName('ts'));
      expect(existsSync(file)).toBe(true);
      const parsed = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>;
      expect(Object.keys(parsed).sort()).toEqual([...contract.statusFile.fields].sort());
      expect(contract.statusFile.states).toContain(parsed.state);
      expect(contract.statusFile.surfaces).toContain(parsed.surface);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('a status file is read back from the data directory', () => {
    const dir = tempDir('memphis-sink-status-read');
    try {
      writeSinkStatus(dir, {
        surface: 'rust',
        state: 'degraded',
        consecutiveFailures: 1,
        lastError: 'boom',
        lastFailureAt: '2026-11-01T10:00:00.000Z',
        lastSuccessAt: null,
        nextRetryAt: '2026-11-01T10:00:01.000Z',
        updatedAt: '2026-11-01T10:00:00.000Z',
      });
      writeFileSync(path.join(dir, 'not-a-status.json'), '{"surface":"x"}');
      const entries = readSinkStatusEntries(dir);
      expect(entries).toHaveLength(1);
      expect(entries[0]?.surface).toBe('rust');
      expect(entries[0]?.state).toBe('degraded');
      expect(entries[0]?.lastError).toBe('boom');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('a broken status file is skipped, not thrown', () => {
    const dir = tempDir('memphis-sink-status-broken');
    try {
      writeFileSync(path.join(dir, 'sink-status-ts.json'), '{not json');
      expect(readSinkStatusEntries(dir)).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('the local span sink recovers instead of dying', () => {
  it('a failed write leaves the sink retryable, and a later write succeeds', () => {
    __resetLocalSinkForTests();
    const dir = tempDir('memphis-sink-retry');
    try {
      const rawEnv = { MEMPHIS_DATA_DIR: dir } as NodeJS.ProcessEnv;
      const at = new Date('2026-11-01T10:00:00.000Z');

      // The telemetry directory is a FILE, so the span write cannot
      // create its directory — a genuine write failure.
      writeFileSync(path.join(dir, 'telemetry'), 'not a directory');

      recordLocalSpan({ name: 'tool.call', attrs: {}, status: 'ok' }, rawEnv, at);

      const state = getLocalSinkRetryState();
      expect(state.consecutiveFailures).toBe(1);
      expect(state.lastError).not.toBeNull();

      // The sink published its own state, so the report can tell a broken
      // sink apart from an idle runtime.
      const entries = readSinkStatusEntries(dir);
      expect(entries).toHaveLength(1);
      expect(entries[0]?.state).toBe('degraded');
      expect(entries[0]?.surface).toBe('ts');

      // Remove the obstruction: the next attempt after the backoff window
      // succeeds, and the sink recovers on its own.
      rmSync(path.join(dir, 'telemetry'), { force: true });
      recordLocalSpan(
        { name: 'tool.call', attrs: {}, status: 'ok' },
        rawEnv,
        new Date(at.getTime() + sinkRetryDelayMs(1) + 1),
      );

      const recovered = getLocalSinkRetryState();
      expect(recovered.consecutiveFailures).toBe(0);
      expect(recovered.nextAttemptAtMs).toBeNull();
      const after = readSinkStatusEntries(dir);
      expect(after[0]?.state).toBe('ok');
      expect(existsSync(path.join(dir, 'telemetry', 'spans-2026-11-01.jsonl'))).toBe(true);
    } finally {
      __resetLocalSinkForTests();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('the SLO report says the sink is degraded instead of reporting no data', () => {
    const dir = tempDir('memphis-sink-slo');
    try {
      // No spans at all — the runtime looks idle.
      const rawEnv = { MEMPHIS_DATA_DIR: dir } as NodeJS.ProcessEnv;
      const idle = evaluateSlos({ rawEnv, now: new Date('2026-11-01T10:00:00.000Z') });
      const idleTool = idle.slos.find((slo) => slo.name === 'tool_error_rate');
      expect(idleTool?.status).toBe('unavailable');
      expect(idleTool?.reason).not.toContain('degraded');

      // The same empty runtime, but the sink that feeds it is broken.
      writeSinkStatus(dir, {
        surface: 'ts',
        state: 'degraded',
        consecutiveFailures: 3,
        lastError: 'EACCES: permission denied',
        lastFailureAt: '2026-11-01T09:59:00.000Z',
        lastSuccessAt: '2026-11-01T09:00:00.000Z',
        nextRetryAt: '2026-11-01T10:00:02.000Z',
        updatedAt: '2026-11-01T09:59:00.000Z',
      });

      const report = evaluateSlos({ rawEnv, now: new Date('2026-11-01T10:00:00.000Z') });
      expect(report.sinkStatus).toHaveLength(1);
      expect(report.sinkStatus[0]?.state).toBe('degraded');
      const tool = report.slos.find((slo) => slo.name === 'tool_error_rate');
      expect(tool?.reason).toContain('the local span sink is degraded');
      expect(tool?.reason).toContain('EACCES');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('the health payload names the degraded sink', async () => {
    const dir = tempDir('memphis-sink-health');
    try {
      writeSinkStatus(dir, {
        surface: 'rust',
        state: 'degraded',
        consecutiveFailures: 4,
        lastError: 'ENOSPC: no space left on device',
        lastFailureAt: '2026-11-01T09:59:00.000Z',
        lastSuccessAt: '2026-11-01T08:00:00.000Z',
        nextRetryAt: '2026-11-01T10:00:08.000Z',
        updatedAt: '2026-11-01T09:59:00.000Z',
      });
      const rawEnv = { MEMPHIS_DATA_DIR: dir } as NodeJS.ProcessEnv;
      const payload = await buildHealthPayload(
        {
          NODE_ENV: 'test',
          HOST: '127.0.0.1',
          PORT: 0,
          LOG_LEVEL: 'error',
          DEFAULT_PROVIDER: 'local-fallback',
          LOCAL_FALLBACK_ENABLED: true,
          GEN_TIMEOUT_MS: 30000,
          GEN_MAX_TOKENS: 256,
          GEN_TEMPERATURE: 0.3,
          RUST_CHAIN_ENABLED: false,
          RUST_CHAIN_BRIDGE_PATH: './crates/memphis-napi',
          DATABASE_URL: 'file:/tmp/memphis-sink-health-unused.db',
        } as AppConfig,
        rawEnv,
      );
      expect(payload.telemetrySinks).toHaveLength(1);
      expect(payload.telemetrySinks?.[0]?.surface).toBe('rust');
      expect(payload.telemetrySinks?.[0]?.state).toBe('degraded');
      expect(payload.telemetrySinks?.[0]?.lastError).toContain('ENOSPC');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('a write inside the backoff window is skipped, not retried in a hot loop', () => {
    __resetLocalSinkForTests();
    const dir = tempDir('memphis-sink-backoff');
    try {
      const rawEnv = { MEMPHIS_DATA_DIR: dir } as NodeJS.ProcessEnv;
      const at = new Date('2026-11-01T10:00:00.000Z');
      writeFileSync(path.join(dir, 'telemetry'), 'not a directory');

      recordLocalSpan({ name: 'tool.call', attrs: {}, status: 'ok' }, rawEnv, at);
      recordLocalSpan({ name: 'tool.call', attrs: {}, status: 'ok' }, rawEnv, at);

      // The second attempt was inside the backoff window: it did not
      // touch the sink, so the failure count did not grow.
      expect(getLocalSinkRetryState().consecutiveFailures).toBe(1);
    } finally {
      __resetLocalSinkForTests();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
