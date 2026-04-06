import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import type { AppConfig } from '../../src/infra/config/schema.js';
import { buildHealthPayload } from '../../src/infra/http/health.js';
import { resetLocalWorkerRuntimeStatusForTests } from '../../src/infra/runtime/local-worker-state.js';
import {
  recordTurnTelemetry,
  resetTurnTelemetryForTests,
} from '../../src/infra/runtime/turn-telemetry.js';
import { createSqliteClient, runMigrations } from '../../src/infra/storage/sqlite/client.js';
import { applyFirstRunPreview, buildMinimalBaselinePreview } from '../../src/onboarding/first-run.js';

function makeConfig(databaseUrl: string): AppConfig {
  return {
    NODE_ENV: 'test',
    HOST: '127.0.0.1',
    PORT: 0,
    LOG_LEVEL: 'error',
    DEFAULT_PROVIDER: 'local-fallback',
    SHARED_LLM_API_BASE: undefined,
    SHARED_LLM_API_KEY: undefined,
    DECENTRALIZED_LLM_API_BASE: undefined,
    DECENTRALIZED_LLM_API_KEY: undefined,
    LOCAL_FALLBACK_ENABLED: true,
    GEN_TIMEOUT_MS: 30000,
    GEN_MAX_TOKENS: 256,
    GEN_TEMPERATURE: 0.3,
    RUST_CHAIN_ENABLED: false,
    RUST_CHAIN_BRIDGE_PATH: './crates/memphis-napi',
    DATABASE_URL: databaseUrl,
  };
}

describe('http health payload', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    resetLocalWorkerRuntimeStatusForTests();
    resetTurnTelemetryForTests();
  });

  it('returns healthy when required checks pass', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'memphis-health-unit-'));
    const dbPath = join(dir, 'test.db');
    const envFile = join(dir, '.env');
    const db = createSqliteClient(`file:${dbPath}`);
    runMigrations(db);
    db.close();
    const dataDir = join(dir, 'data');
    mkdirSync(dataDir, { recursive: true });
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ status: 200, ok: true }) as typeof fetch);

    const payload = await buildHealthPayload(makeConfig(`file:${dbPath}`), {
      MEMPHIS_DATA_DIR: dataDir,
      MEMPHIS_ENV_FILE: envFile,
      RUST_CHAIN_ENABLED: 'false',
      RUST_EMBED_MODE: 'local',
    });

    expect(payload.status).toBe('unhealthy');
    expect(payload.repairable).toBe(true);
    expect(payload.recommendedAction).toBe('Run memphis init');
    expect(payload.checks.database.status).toBe('ok');
    expect(payload.checks.data_dir.status).toBe('ok');
    expect(payload.checks.rust_bridge.status).toBe('ok');
    expect(payload.runtime.firstRun.state).toBe('not-initialized');
    expect(payload.runtime.offline.activeMode).toBe('local-fallback');
    expect(payload.runtime.offline.supportedModes).toContain('local-fallback');
    expect(payload.runtime.exactSearch.status).toBe('empty');
    expect(payload.runtime.chainMemory.status).toBe('missing');
    expect(payload.runtime.memory.recallMode).toBe('none');
    expect(payload.runtime.cognition.persistenceStatus).toBe('unavailable');
    expect(payload.runtime.repair.status).toBe('degraded-repairable');
    expect(payload.runtime.firstRun.plan).toMatchObject({
      suggestedMode: 'guided-conversation',
      nextCommand: 'npm run bootstrap',
      preview: expect.objectContaining({
        minimalBaseline: expect.objectContaining({ createdBlocks: 2 }),
        guidedConversation: expect.objectContaining({ createdBlocks: 4 }),
      }),
    });
    expect(payload.surfacePolicies).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ surface: 'telegram', maxToolTier: 0, allowUrlFetch: false }),
        expect.objectContaining({ surface: 'cli.chat', allowOperatorOverride: true }),
      ]),
    );
    expect(payload.localWorker).toBeNull();
    expect(payload.scheduler).toMatchObject({
      configuredTarget: 'local',
      effectiveTarget: 'local',
      running: false,
      tasks: {
        total: expect.any(Number),
        enabled: expect.any(Number),
        overdue: expect.any(Number),
      },
    });
    expect(payload.latestTurnTelemetry).toEqual([]);
  });

  it('returns unhealthy when sqlite file is missing', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'memphis-health-unit-missing-'));
    const missingDb = join(dir, 'missing.db');
    const dataDir = join(dir, 'data');
    const envFile = join(dir, '.env');
    mkdirSync(dataDir, { recursive: true });
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ status: 503, ok: false }) as typeof fetch);

    const payload = await buildHealthPayload(makeConfig(`file:${missingDb}`), {
      MEMPHIS_DATA_DIR: dataDir,
      MEMPHIS_ENV_FILE: envFile,
      RUST_CHAIN_ENABLED: 'false',
      RUST_EMBED_MODE: 'local',
    });

    expect(payload.status).toBe('unhealthy');
    expect(payload.repairable).toBe(true);
    expect(payload.recommendedAction).toBe('Run memphis init');
    expect(payload.checks.database.status).toBe('fail');
    expect(payload.runtime.exactSearch.status).toBe('unavailable');
    expect(payload.runtime.memory.recallMode).toBe('none');
    expect(payload.runtime.repair.status).toBe('degraded-repairable');
    expect(payload.runtime.firstRun.plan.nextCommand).toBe('npm run bootstrap');
    expect(payload.surfacePolicies).toEqual(
      expect.arrayContaining([expect.objectContaining({ surface: 'http.chat.generate' })]),
    );
    expect(payload.localWorker).toBeNull();
    expect(payload.scheduler).toMatchObject({
      configuredTarget: 'local',
      effectiveTarget: 'local',
      running: false,
      tasks: {
        total: expect.any(Number),
        enabled: expect.any(Number),
        overdue: expect.any(Number),
      },
    });
    expect(payload.latestTurnTelemetry).toEqual([]);
  });

  it('returns healthy for initialized local-fallback runtime with bounded recall fallback', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'memphis-health-unit-bounded-'));
    const dbPath = join(dir, 'test.db');
    const envFile = join(dir, '.env');
    const db = createSqliteClient(`file:${dbPath}`);
    runMigrations(db);
    db.close();
    const dataDir = join(dir, 'data');
    mkdirSync(dataDir, { recursive: true });
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ status: 503, ok: false }) as typeof fetch);

    writeFileSync(envFile, 'DEFAULT_PROVIDER=local-fallback\nLOCAL_FALLBACK_ENABLED=true\n', 'utf8');

    const env = {
      MEMPHIS_DATA_DIR: dataDir,
      MEMPHIS_ENV_FILE: envFile,
      RUST_CHAIN_ENABLED: 'false',
      RUST_EMBED_MODE: 'local',
      DEFAULT_PROVIDER: 'local-fallback',
      LOCAL_FALLBACK_ENABLED: 'true',
      DATABASE_URL: `file:${dbPath}`,
    } satisfies NodeJS.ProcessEnv;

    const previousEnv = { ...process.env };
    process.env = { ...previousEnv, ...env };
    try {
      await applyFirstRunPreview(buildMinimalBaselinePreview(env), env);
    } finally {
      process.env = previousEnv;
    }

    const payload = await buildHealthPayload(makeConfig(`file:${dbPath}`), env);

    expect(payload.status).toBe('healthy');
    expect(payload.repairable).toBe(true);
    expect(payload.recommendedAction).toBe('Run memphis repair runtime');
    expect(payload.runtime.firstRun.state).toBe('initialized-clean');
    expect(payload.runtime.offline.activeMode).toBe('local-fallback');
    expect(payload.runtime.offline.ready).toBe(true);
    expect(payload.runtime.chainMemory.status).toBe('ready');
    expect(payload.runtime.memory.recallMode).not.toBe('none');
  });

  it('includes latest turn telemetry snapshots', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'memphis-health-unit-telemetry-'));
    const dbPath = join(dir, 'test.db');
    const envFile = join(dir, '.env');
    const db = createSqliteClient(`file:${dbPath}`);
    runMigrations(db);
    db.close();
    const dataDir = join(dir, 'data');
    mkdirSync(dataDir, { recursive: true });
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ status: 200, ok: true }) as typeof fetch);

    recordTurnTelemetry({
      surface: 'http.chat.generate',
      provider: 'ollama',
      model: 'qwen2.5-coder:3b',
      telemetry: {
        usage: { inputTokens: 12, outputTokens: 8, totalTokens: 20 },
        contextWindowTokens: 8192,
        estimatedPromptTokens: 100,
        remainingContextTokens: 8092,
        degraded: false,
      },
      recordedAt: '2026-04-02T10:00:00.000Z',
    });

    const payload = await buildHealthPayload(makeConfig(`file:${dbPath}`), {
      MEMPHIS_DATA_DIR: dataDir,
      MEMPHIS_ENV_FILE: envFile,
      RUST_CHAIN_ENABLED: 'false',
      RUST_EMBED_MODE: 'local',
    });

    expect(payload.latestTurnTelemetry).toEqual([
      expect.objectContaining({
        surface: 'http.chat.generate',
        provider: 'ollama',
        model: 'qwen2.5-coder:3b',
        recordedAt: '2026-04-02T10:00:00.000Z',
        telemetry: expect.objectContaining({
          contextWindowTokens: 8192,
          usage: expect.objectContaining({ totalTokens: 20 }),
        }),
      }),
    ]);
  });
});
