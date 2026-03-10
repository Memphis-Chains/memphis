import { describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AppConfig } from '../../src/infra/config/schema.js';
import { buildHealthPayload } from '../../src/infra/http/health.js';

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
  it('returns healthy when required checks pass', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'memphis-v4-health-unit-'));
    const dbPath = join(dir, 'test.db');
    writeFileSync(dbPath, '');
    const dataDir = join(dir, 'data');
    mkdirSync(dataDir, { recursive: true });

    const payload = await buildHealthPayload(makeConfig(`file:${dbPath}`), {
      MEMPHIS_DATA_DIR: dataDir,
      RUST_CHAIN_ENABLED: 'false',
      RUST_EMBED_MODE: 'local',
    });

    expect(payload.status).toBe('healthy');
    expect(payload.checks.database.status).toBe('ok');
    expect(payload.checks.data_dir.status).toBe('ok');
    expect(payload.checks.rust_bridge.status).toBe('ok');
  });

  it('returns unhealthy when sqlite file is missing', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'memphis-v4-health-unit-missing-'));
    const missingDb = join(dir, 'missing.db');
    const dataDir = join(dir, 'data');
    mkdirSync(dataDir, { recursive: true });

    const payload = await buildHealthPayload(makeConfig(`file:${missingDb}`), {
      MEMPHIS_DATA_DIR: dataDir,
      RUST_CHAIN_ENABLED: 'false',
      RUST_EMBED_MODE: 'local',
    });

    expect(payload.status).toBe('unhealthy');
    expect(payload.checks.database.status).toBe('fail');
  });
});
