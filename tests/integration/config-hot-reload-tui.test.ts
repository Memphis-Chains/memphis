import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { executeTuiHostCommand } from '../../src/infra/tui-host/commands.js';

interface TestEnv {
  envDir: string;
  envPath: string;
}

function setupTempEnv(): TestEnv {
  const envDir = mkdtempSync(join(tmpdir(), 'memphis-cfg-tui-'));
  const envPath = join(envDir, '.env');
  writeFileSync(envPath, 'GEN_MAX_TOKENS=1024\n', 'utf8');
  return { envDir, envPath };
}

function makeCtx() {
  const lines: Array<{ level: string; text: string }> = [];
  return {
    lines,
    ctx: {
      emitLine: (level: 'info' | 'warning' | 'error', text: string) => {
        lines.push({ level, text });
      },
      signal: new AbortController().signal,
    },
  };
}

describe('TUI host config.* capabilities (Sprint 6)', () => {
  const savedEnv: NodeJS.ProcessEnv = { ...process.env };
  let env: TestEnv;

  beforeEach(() => {
    env = setupTempEnv();
    process.env.MEMPHIS_ENV_FILE = env.envPath;
    process.env.GEN_MAX_TOKENS = '1024';
  });

  afterEach(() => {
    rmSync(env.envDir, { recursive: true, force: true });
    for (const key of Object.keys(process.env)) {
      if (!(key in savedEnv)) delete process.env[key];
    }
    Object.assign(process.env, savedEnv);
  });

  it('config.show returns redacted values for known keys', async () => {
    process.env.ANTHROPIC_API_KEY = 'sk-ant-secret';
    const { ctx } = makeCtx();
    const result = (await executeTuiHostCommand('config.show', undefined, ctx)) as {
      values: Record<string, string>;
    };
    expect(result.values.GEN_MAX_TOKENS).toBe('1024');
    expect(result.values.ANTHROPIC_API_KEY).toBe('***redacted***');
  });

  it('config.set rejects cold fields with an error', async () => {
    const { ctx } = makeCtx();
    await expect(
      executeTuiHostCommand('config.set', { key: 'PORT', value: '5555' }, ctx),
    ).rejects.toThrow(/cold field/);
    expect(process.env.PORT).not.toBe('5555');
  });

  it('config.set rejects secret fields without tier-3 elevation', async () => {
    const { ctx } = makeCtx();
    await expect(
      executeTuiHostCommand(
        'config.set',
        { key: 'ANTHROPIC_API_KEY', value: 'sk-new' },
        ctx,
      ),
    ).rejects.toThrow(/tier-3/);
  });

  it('config.set applies hot-field changes to process.env and .env', async () => {
    const { ctx } = makeCtx();
    const result = (await executeTuiHostCommand(
      'config.set',
      { key: 'GEN_MAX_TOKENS', value: '4096' },
      ctx,
    )) as { newValue: string; tier: string };
    expect(result.tier).toBe('hot');
    expect(result.newValue).toBe('4096');
    expect(process.env.GEN_MAX_TOKENS).toBe('4096');
  });

  it('config.reload picks up .env changes for hot fields', async () => {
    writeFileSync(env.envPath, 'GEN_MAX_TOKENS=8192\n', 'utf8');
    const { ctx } = makeCtx();
    const result = (await executeTuiHostCommand('config.reload', undefined, ctx)) as {
      ok: boolean;
      appliedCount: number;
    };
    expect(result.ok).toBe(true);
    expect(result.appliedCount).toBe(1);
    expect(process.env.GEN_MAX_TOKENS).toBe('8192');
  });

  it('config.reload refuses to apply cold-field changes', async () => {
    writeFileSync(env.envPath, 'GEN_MAX_TOKENS=1024\nPORT=4001\n', 'utf8');
    const { ctx } = makeCtx();
    const result = (await executeTuiHostCommand('config.reload', undefined, ctx)) as {
      ok: boolean;
      rejectedCold: string[];
    };
    expect(result.ok).toBe(false);
    expect(result.rejectedCold).toContain('PORT');
    expect(process.env.PORT).not.toBe('4001');
  });

  it('config.set rejects values that fail schema validation', async () => {
    const { ctx } = makeCtx();
    await expect(
      executeTuiHostCommand(
        'config.set',
        { key: 'GEN_MAX_TOKENS', value: '99999999' },
        ctx,
      ),
    ).rejects.toThrow(/Validation failed/);
  });

  it('config.set refuses values containing newlines (.env injection guard)', async () => {
    const { ctx } = makeCtx();
    await expect(
      executeTuiHostCommand(
        'config.set',
        { key: 'GEN_MAX_TOKENS', value: '4096\nMEMPHIS_API_TOKEN=evil' },
        ctx,
      ),
    ).rejects.toThrow(/newline/);
  });
});
