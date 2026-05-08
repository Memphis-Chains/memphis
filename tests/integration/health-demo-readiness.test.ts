import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { AppConfig } from '../../src/infra/config/schema.js';
import { buildHealthPayload } from '../../src/infra/http/health.js';

interface TestEnv {
  dataDir: string;
  savedDataDir: string | undefined;
}

function setup(): TestEnv {
  const dataDir = mkdtempSync(join(tmpdir(), 'memphis-health-demo-'));
  const savedDataDir = process.env.MEMPHIS_DATA_DIR;
  process.env.MEMPHIS_DATA_DIR = dataDir;
  return { dataDir, savedDataDir };
}

function teardown(env: TestEnv): void {
  if (env.savedDataDir === undefined) delete process.env.MEMPHIS_DATA_DIR;
  else process.env.MEMPHIS_DATA_DIR = env.savedDataDir;
  rmSync(env.dataDir, { recursive: true, force: true });
}

const minimalConfig = {
  DATABASE_URL: 'file:./test.db',
} as unknown as AppConfig;

describe('Phase 3.4: /v1/ops/status demo readiness block', () => {
  let env: TestEnv;

  beforeEach(() => {
    env = setup();
  });

  afterEach(() => {
    teardown(env);
  });

  it('reports demo.armed=false when no demo-armed.json exists', async () => {
    const payload = await buildHealthPayload(minimalConfig);
    expect(payload.demo).toBeDefined();
    expect(payload.demo.armed).toBe(false);
    expect(payload.demo.armedAt).toBeNull();
    expect(payload.demo.armedBy).toBeNull();
    expect(payload.demo.lastRehearseAt).toBeNull();
    expect(payload.demo.planBReady).toBe(false);
  });

  it('reports demo.armed=true when state file is present + valid', async () => {
    mkdirSync(env.dataDir, { recursive: true });
    writeFileSync(
      join(env.dataDir, 'demo-armed.json'),
      JSON.stringify({
        armedAt: '2026-05-08T14:30:00.000Z',
        armedBy: 'wodzu',
        checks: [{ id: 'doctor', title: 'Doctor v2', status: 'pass', detail: 'ok' }],
        expiresHint: 'rerun before stage',
      }),
      'utf8',
    );
    const payload = await buildHealthPayload(minimalConfig);
    expect(payload.demo.armed).toBe(true);
    expect(payload.demo.armedAt).toBe('2026-05-08T14:30:00.000Z');
    expect(payload.demo.armedBy).toBe('wodzu');
  });

  it('reports demo.armed=false when state file is empty (disarmed)', async () => {
    mkdirSync(env.dataDir, { recursive: true });
    writeFileSync(join(env.dataDir, 'demo-armed.json'), '', 'utf8');
    const payload = await buildHealthPayload(minimalConfig);
    expect(payload.demo.armed).toBe(false);
  });

  it('reports demo.armed=false when state file is malformed JSON (graceful fallback)', async () => {
    mkdirSync(env.dataDir, { recursive: true });
    writeFileSync(join(env.dataDir, 'demo-armed.json'), 'not-json {', 'utf8');
    const payload = await buildHealthPayload(minimalConfig);
    // Should NOT throw — best-effort surface.
    expect(payload.demo.armed).toBe(false);
  });
});
