import { mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import type { AppConfig } from '../../src/infra/config/schema.js';
import { buildHealthPayload } from '../../src/infra/http/health.js';
import { createSqliteClient, runMigrations } from '../../src/infra/storage/sqlite/client.js';

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
  });

  it('returns healthy when required checks pass', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'memphis-health-unit-'));
    const dbPath = join(dir, 'test.db');
    const db = createSqliteClient(`file:${dbPath}`);
    runMigrations(db);
    db.close();
    const dataDir = join(dir, 'data');
    mkdirSync(dataDir, { recursive: true });
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ status: 200, ok: true }) as typeof fetch);

    const payload = await buildHealthPayload(makeConfig(`file:${dbPath}`), {
      MEMPHIS_DATA_DIR: dataDir,
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
  });

  it('returns unhealthy when sqlite file is missing', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'memphis-health-unit-missing-'));
    const missingDb = join(dir, 'missing.db');
    const dataDir = join(dir, 'data');
    mkdirSync(dataDir, { recursive: true });
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ status: 503, ok: false }) as typeof fetch);

    const payload = await buildHealthPayload(makeConfig(`file:${missingDb}`), {
      MEMPHIS_DATA_DIR: dataDir,
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
  });
});
