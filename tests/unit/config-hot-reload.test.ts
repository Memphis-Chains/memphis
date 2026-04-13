import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  computeReloadPlan,
  performHotReload,
  redactFieldValue,
  redactReloadResult,
  snapshotRedactedEnv,
} from '../../src/infra/config/hot-reload.js';

interface TestEnv {
  envDir: string;
  envPath: string;
  baseEnv: NodeJS.ProcessEnv;
}

function setupEnv(): TestEnv {
  const envDir = mkdtempSync(join(tmpdir(), 'memphis-cfg-'));
  const envPath = join(envDir, '.env');
  const baseEnv: NodeJS.ProcessEnv = {
    MEMPHIS_ENV_FILE: envPath,
    GEN_MAX_TOKENS: '1024',
    LOG_LEVEL: 'info',
    PORT: '3000',
    ANTHROPIC_API_KEY: 'sk-ant-old',
  };
  return { envDir, envPath, baseEnv };
}

function writeEnv(envPath: string, lines: Record<string, string>): void {
  const body = Object.entries(lines)
    .map(([k, v]) => `${k}=${v}`)
    .join('\n');
  writeFileSync(envPath, `${body}\n`);
}

describe('hot-reload — computeReloadPlan', () => {
  let testEnv: TestEnv;

  beforeEach(() => {
    testEnv = setupEnv();
  });

  afterEach(() => {
    rmSync(testEnv.envDir, { recursive: true, force: true });
  });

  it('reports unchanged fields as unchanged', () => {
    writeEnv(testEnv.envPath, { GEN_MAX_TOKENS: '1024', LOG_LEVEL: 'info' });
    const plan = computeReloadPlan({ baseEnv: testEnv.baseEnv });
    expect(plan.appliedCount).toBe(0);
    expect(plan.unchangedCount).toBe(2);
    expect(plan.ok).toBe(true);
  });

  it('classifies hot field changes as applied', () => {
    writeEnv(testEnv.envPath, { GEN_MAX_TOKENS: '4096' });
    const plan = computeReloadPlan({ baseEnv: testEnv.baseEnv });
    const change = plan.changes.find((c) => c.key === 'GEN_MAX_TOKENS');
    expect(change?.status).toBe('applied');
    expect(change?.tier).toBe('hot');
    expect(change?.oldValue).toBe('1024');
    expect(change?.newValue).toBe('4096');
    expect(plan.ok).toBe(true);
  });

  it('rejects cold field changes with rejected-cold and ok=false', () => {
    writeEnv(testEnv.envPath, { PORT: '4000' });
    const plan = computeReloadPlan({ baseEnv: testEnv.baseEnv });
    const change = plan.changes.find((c) => c.key === 'PORT');
    expect(change?.status).toBe('rejected-cold');
    expect(change?.tier).toBe('cold');
    expect(plan.rejectedCold).toContain('PORT');
    expect(plan.ok).toBe(false);
  });

  it('returns ok=false with validationError when a value violates schema', () => {
    writeEnv(testEnv.envPath, { GEN_MAX_TOKENS: '99999999' });
    const plan = computeReloadPlan({ baseEnv: testEnv.baseEnv });
    expect(plan.ok).toBe(false);
    expect(plan.validationError).toBeDefined();
    expect(plan.invalidCount).toBe(1);
  });

  it('passes ok=true when only valid hot/warm fields change', () => {
    writeEnv(testEnv.envPath, {
      GEN_MAX_TOKENS: '2048',
      GEN_TEMPERATURE: '0.6',
      LOG_LEVEL: 'debug',
    });
    const plan = computeReloadPlan({ baseEnv: testEnv.baseEnv });
    expect(plan.ok).toBe(true);
    expect(plan.appliedCount).toBe(3);
    expect(plan.rejectedCold).toEqual([]);
  });
});

describe('hot-reload — performHotReload mutates process.env', () => {
  let savedEnv: NodeJS.ProcessEnv;
  let testEnv: TestEnv;

  beforeEach(() => {
    savedEnv = { ...process.env };
    testEnv = setupEnv();
    Object.assign(process.env, testEnv.baseEnv);
  });

  afterEach(() => {
    rmSync(testEnv.envDir, { recursive: true, force: true });
    for (const key of Object.keys(process.env)) {
      if (!(key in savedEnv)) delete process.env[key];
    }
    Object.assign(process.env, savedEnv);
  });

  it('writes hot field changes into process.env', async () => {
    writeEnv(testEnv.envPath, { GEN_MAX_TOKENS: '4096' });
    const result = await performHotReload();
    expect(result.ok).toBe(true);
    expect(process.env.GEN_MAX_TOKENS).toBe('4096');
  });

  it('refuses to mutate process.env when a cold field is changing', async () => {
    writeEnv(testEnv.envPath, { PORT: '5555', GEN_MAX_TOKENS: '4096' });
    const result = await performHotReload();
    expect(result.ok).toBe(false);
    expect(process.env.PORT).toBe('3000');
    expect(process.env.GEN_MAX_TOKENS).toBe('1024');
  });
});

describe('hot-reload — redaction', () => {
  it('redactFieldValue obscures secret fields and passes through hot fields', () => {
    expect(redactFieldValue('ANTHROPIC_API_KEY', 'sk-ant-secret')).toBe('***redacted***');
    expect(redactFieldValue('GEN_MAX_TOKENS', '4096')).toBe('4096');
    expect(redactFieldValue('UNKNOWN_KEY', 'visible')).toBe('visible');
    expect(redactFieldValue('GEN_TIMEOUT_MS', undefined)).toBe('');
  });

  it('redactReloadResult masks secret values in the changes array', () => {
    const result = {
      ok: true,
      envPath: '/tmp/.env',
      changes: [
        {
          key: 'ANTHROPIC_API_KEY',
          tier: 'secret' as const,
          status: 'applied' as const,
          oldValue: 'sk-ant-old',
          newValue: 'sk-ant-new',
        },
      ],
      appliedCount: 1,
      rejectedColdCount: 0,
      unchangedCount: 0,
      invalidCount: 0,
      rejectedCold: [],
    };
    const redacted = redactReloadResult(result);
    expect(redacted.changes[0]?.oldValue).toBe('***redacted***');
    expect(redacted.changes[0]?.newValue).toBe('***redacted***');
  });

  it('snapshotRedactedEnv masks secret keys but keeps hot keys visible', () => {
    const env = {
      GEN_MAX_TOKENS: '4096',
      ANTHROPIC_API_KEY: 'sk-ant-secret',
      LOG_LEVEL: 'info',
    };
    const snap = snapshotRedactedEnv(env);
    expect(snap.GEN_MAX_TOKENS).toBe('4096');
    expect(snap.ANTHROPIC_API_KEY).toBe('***redacted***');
    expect(snap.LOG_LEVEL).toBe('info');
  });
});
