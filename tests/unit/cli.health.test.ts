import { mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { getAppVersion } from '../../src/config/paths.js';
import { createSqliteClient, runMigrations } from '../../src/infra/storage/sqlite/client.js';
import { runCli } from '../helpers/cli.js';

describe('CLI health', () => {
  it('prints JSON for health command', async () => {
    const runtimeDir = mkdtempSync(join(tmpdir(), 'memphis-cli-health-'));
    const dbPath = join(runtimeDir, 'health.db');
    const dataDir = join(runtimeDir, '.memphis');
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
  });
});
