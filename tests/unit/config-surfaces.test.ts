import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { createCliContext } from '../../src/infra/cli/context.js';
import { configCommandHandler } from '../../src/infra/cli/handlers/config.handler.js';
import { parseCommand } from '../../src/infra/cli/parser.js';

describe('config surfaces command', () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    vi.restoreAllMocks();
    process.env = { ...originalEnv };
  });

  it('persists a surface override into the configured .env file and applies it immediately', async () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'memphis-config-surfaces-'));
    const envPath = join(tempDir, '.env');
    writeFileSync(envPath, 'DEFAULT_PROVIDER=local-fallback\n', 'utf8');
    process.env = {
      ...originalEnv,
      MEMPHIS_ENV_FILE: envPath,
    };

    const argv = [
      'node',
      'memphis',
      'config',
      'surfaces',
      'set',
      'telegram',
      'max-tool-tier',
      '--value',
      '1',
      '--json',
    ];
    const context = createCliContext(argv, parseCommand(argv));
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);

    const handled = await configCommandHandler.handle(context);

    expect(handled).toBe(true);
    expect(process.env.MEMPHIS_SURFACE_TELEGRAM_MAX_TOOL_TIER).toBe('1');
    expect(readFileSync(envPath, 'utf8')).toContain('MEMPHIS_SURFACE_TELEGRAM_MAX_TOOL_TIER=1');
    const payload = JSON.parse(log.mock.calls[0]?.[0] as string);
    expect(payload.policy).toMatchObject({
      surface: 'telegram',
      maxToolTier: 1,
    });
  });

  it('resets surface overrides from .env and falls back to hardened defaults', async () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'memphis-config-surfaces-reset-'));
    const envPath = join(tempDir, '.env');
    writeFileSync(
      envPath,
      [
        'DEFAULT_PROVIDER=local-fallback',
        'MEMPHIS_SURFACE_TELEGRAM_MAX_TOOL_TIER=1',
        'MEMPHIS_SURFACE_TELEGRAM_ALLOW_URL_FETCH=true',
      ].join('\n'),
      'utf8',
    );
    process.env = {
      ...originalEnv,
      MEMPHIS_ENV_FILE: envPath,
      MEMPHIS_SURFACE_TELEGRAM_MAX_TOOL_TIER: '1',
      MEMPHIS_SURFACE_TELEGRAM_ALLOW_URL_FETCH: 'true',
    };

    const argv = ['node', 'memphis', 'config', 'surfaces', 'reset', 'telegram', '--json'];
    const context = createCliContext(argv, parseCommand(argv));
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);

    const handled = await configCommandHandler.handle(context);

    expect(handled).toBe(true);
    const envText = readFileSync(envPath, 'utf8');
    expect(envText).not.toContain('MEMPHIS_SURFACE_TELEGRAM_MAX_TOOL_TIER=');
    expect(envText).not.toContain('MEMPHIS_SURFACE_TELEGRAM_ALLOW_URL_FETCH=');
    const payload = JSON.parse(log.mock.calls[0]?.[0] as string);
    expect(payload.policy).toMatchObject({
      surface: 'telegram',
      maxToolTier: 0,
      allowUrlFetch: false,
    });
  });
});
