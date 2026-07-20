import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { getAppVersion } from '../../src/config/paths.js';
import { resetLocalWorkerRuntimeStatusForTests } from '../../src/infra/runtime/local-worker-state.js';
import { createSqliteClient, runMigrations } from '../../src/infra/storage/sqlite/client.js';
import { runCli } from '../helpers/cli.js';

describe('CLI health', () => {
  afterEach(() => {
    resetLocalWorkerRuntimeStatusForTests();
  });

  it('prints JSON for health command', async () => {
    const runtimeDir = mkdtempSync(join(tmpdir(), 'memphis-cli-health-'));
    const dbPath = join(runtimeDir, 'health.db');
    const dataDir = join(runtimeDir, '.memphis');
    const envFile = join(runtimeDir, '.env');
    const db = createSqliteClient(`file:${dbPath}`);
    runMigrations(db);
    db.close();
    mkdirSync(dataDir, { recursive: true });

    const out = await runCli(['health', '--json'], {
      env: {
        DEFAULT_PROVIDER: 'local-fallback',
        LOCAL_FALLBACK_ENABLED: 'true',
        DATABASE_URL: `file:${dbPath}`,
        MEMPHIS_DATA_DIR: dataDir,
        MEMPHIS_ENV_FILE: envFile,
        RUST_CHAIN_ENABLED: 'false',
        RUST_EMBED_MODE: 'local',
      },
    });

    const data = JSON.parse(out);
    expect(data.status).toBe('ok');
    expect(data.service).toBe('memphis');
    expect(data.version).toBe(getAppVersion());
    expect(data.runtimeStatus).toBe('unhealthy');
    expect(data.repairable).toBe(true);
    expect(data.recommendedAction).toBe('Run memphis init');
    expect(data.runtime.firstRun.state).toBe('not-initialized');
    expect(data.runtime.offline.activeMode).toBe('local-fallback');
    expect(data.runtime.chainMemory.chainRoot).toContain('.memphis/chains');
    expect(data.runtime.memory.recallMode).toBe('none');
    expect(data.runtime.cognition.persistenceStatus).toBe('unavailable');
    expect(data.runtime.repair.status).toBe('degraded-repairable');
    expect(data.workPolling).toMatchObject({
      tokenReady: false,
      sessions: expect.objectContaining({ total: 0, active: 0 }),
      work: expect.objectContaining({ total: 0, pending: 0, leased: 0 }),
    });
    expect(data.localWorker).toBeNull();
    expect(data.scheduler).toMatchObject({
      configuredTarget: 'local',
      effectiveTarget: 'local',
      running: false,
      workerLaneReady: false,
      tasks: {
        total: 0,
        enabled: 0,
        overdue: 0,
      },
    });
    expect(data.runtime.firstRun.plan).toMatchObject({
      suggestedMode: 'guided-conversation',
      nextCommand: 'npm run bootstrap',
      preview: expect.objectContaining({
        minimalBaseline: expect.objectContaining({ createdBlocks: 2 }),
        guidedConversation: expect.objectContaining({ createdBlocks: 4 }),
      }),
    });
  });

  it('prints JSON for slo status command', async () => {
    const runtimeDir = mkdtempSync(join(tmpdir(), 'memphis-cli-slo-'));
    const dataDir = join(runtimeDir, '.memphis');
    const envFile = join(runtimeDir, '.env');
    const telemetryDir = join(dataDir, 'telemetry');
    mkdirSync(telemetryDir, { recursive: true });

    const now = new Date();
    const today = now.toISOString().slice(0, 10);
    const spans = [
      ...Array.from({ length: 10 }, (_, i) => ({
        ts: new Date(now.getTime() - i * 1000).toISOString(),
        name: 'turn.dispatch',
        status: 'ok',
        durationMs: 100 + i,
        attrs: { 'turn.timing_ms': 100 + i },
      })),
      ...Array.from({ length: 10 }, (_, i) => ({
        ts: new Date(now.getTime() - (20 + i) * 1000).toISOString(),
        name: 'provider.completion',
        status: 'ok',
      })),
      ...Array.from({ length: 10 }, (_, i) => ({
        ts: new Date(now.getTime() - (40 + i) * 1000).toISOString(),
        name: 'tool.call',
        status: 'ok',
      })),
    ];
    writeFileSync(
      join(telemetryDir, `spans-${today}.jsonl`),
      `${spans.map((span) => JSON.stringify(span)).join('\n')}\n`,
      'utf8',
    );

    const out = await runCli(['slo', 'status', '--days', '1', '--json'], {
      env: {
        MEMPHIS_DATA_DIR: dataDir,
        MEMPHIS_ENV_FILE: envFile,
      },
    });

    const data = JSON.parse(out);
    expect(data.ok).toBe(true);
    expect(data.allSlosPassing).toBe(true);
    expect(data.windowDays).toBe(1);
    expect(data.failingSlos).toEqual([]);
    expect(data.slos.map((slo: { name: string }) => slo.name)).toEqual([
      'p99_turn_latency_ms',
      'confabulation_rate',
      'provider_error_rate',
      'tool_error_rate',
    ]);
  });
});
