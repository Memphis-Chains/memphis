import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { runDoctorChecksV2 } from '../../src/infra/cli/utils/doctor-v2.js';
import { createSqliteClient, runMigrations } from '../../src/infra/storage/sqlite/client.js';

describe('doctor fresh install state', () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    vi.restoreAllMocks();
    process.env = { ...originalEnv };
  });

  it('does not treat first-run markers and embed dir as orphan files', async () => {
    const memphisDir = mkdtempSync(join(tmpdir(), 'memphis-doctor-'));
    const dbPath = join(mkdtempSync(join(tmpdir(), 'memphis-doctor-db-')), 'doctor.db');
    mkdirSync(join(memphisDir, 'embed'), { recursive: true });
    mkdirSync(join(memphisDir, 'config'), { recursive: true });
    writeFileSync(join(memphisDir, '.first-run-checks'), new Date().toISOString());
    writeFileSync(join(memphisDir, 'config/config.yaml'), '{}\n');
    const db = createSqliteClient(`file:${dbPath}`);
    runMigrations(db);
    db.close();

    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ status: 200, ok: true }) as typeof fetch);

    process.env = {
      ...originalEnv,
      NODE_ENV: 'test',
      MEMPHIS_DATA_DIR: memphisDir,
      DATABASE_URL: `file:${dbPath}`,
      RUST_CHAIN_ENABLED: 'false',
    };

    const report = await runDoctorChecksV2();
    const orphanCheck = report.checks.find((check) => check.id === 't5-orphans');
    const latencyCheck = report.checks.find((check) => check.id === 't3-embed-search-latency');
    const chainMemoryCheck = report.checks.find((check) => check.id === 't1-chain-memory-source');
    const firstRunCheck = report.checks.find((check) => check.id === 't1-first-run-contract');
    const exactSearchCheck = report.checks.find((check) => check.id === 't1-exact-search-state');
    const recallModeCheck = report.checks.find((check) => check.id === 't1-recall-mode');
    const cognitivePersistenceCheck = report.checks.find(
      (check) => check.id === 't1-cognitive-persistence',
    );

    expect(orphanCheck?.level).toBe('pass');
    expect(orphanCheck?.detail).toBe('none detected');
    expect(latencyCheck?.detail).toBe('not measured (empty index)');
    expect(latencyCheck?.level).toBe('pass');
    expect(chainMemoryCheck?.level).toBe('fail');
    expect(chainMemoryCheck?.detail).toContain('missing chain root');
    expect(firstRunCheck?.level).toBe('warn');
    expect(firstRunCheck?.detail).toContain('state=not-initialized');
    expect(exactSearchCheck?.detail).toContain('empty index');
    expect(recallModeCheck?.detail).toContain('mode=none');
    expect(cognitivePersistenceCheck?.detail).toContain('status=unavailable');
    expect(report.repairStatus).toBe('degraded-repairable');
    expect(report.repairable).toBe(true);
    expect(report.recommendedAction).toBe('Run npm run bootstrap first');
  });
});
