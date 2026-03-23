import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { runDoctorChecksV2 } from '../../src/infra/cli/utils/doctor-v2.js';

describe('doctor fresh install state', () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    vi.restoreAllMocks();
    process.env = { ...originalEnv };
  });

  it('does not treat first-run markers and embed dir as orphan files', async () => {
    const memphisDir = mkdtempSync(join(tmpdir(), 'memphis-doctor-'));
    mkdirSync(join(memphisDir, 'embed'), { recursive: true });
    mkdirSync(join(memphisDir, 'config'), { recursive: true });
    writeFileSync(join(memphisDir, '.first-run-checks'), new Date().toISOString());
    writeFileSync(join(memphisDir, 'config/config.yaml'), '{}\n');

    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ status: 200, ok: true }) as typeof fetch);

    process.env = {
      ...originalEnv,
      NODE_ENV: 'test',
      MEMPHIS_DATA_DIR: memphisDir,
      RUST_CHAIN_ENABLED: 'false',
    };

    const report = await runDoctorChecksV2();
    const orphanCheck = report.checks.find((check) => check.id === 't5-orphans');
    const latencyCheck = report.checks.find((check) => check.id === 't3-embed-search-latency');

    expect(orphanCheck?.level).toBe('pass');
    expect(orphanCheck?.detail).toBe('none detected');
    expect(latencyCheck?.detail).toBe('not measured (empty index)');
    expect(latencyCheck?.level).toBe('pass');
  });
});
