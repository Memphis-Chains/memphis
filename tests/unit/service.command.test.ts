import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { handleServiceCommand, resetRuntimeState } from '../../src/infra/cli/commands/service.js';
import type { CliContext } from '../../src/infra/cli/context.js';
import { buildUserServiceUnit, resolveRuntimeRoot } from '../../src/infra/runtime/user-service.js';

function makeRuntimeRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'memphis-service-'));
  mkdirSync(join(root, 'dist/infra/cli'), { recursive: true });
  writeFileSync(
    join(root, 'package.json'),
    JSON.stringify({ name: '@memphis-chains/memphis', version: '0.4.0' }),
  );
  writeFileSync(join(root, 'dist/infra/cli/index.js'), 'console.log("serve")\n');
  return root;
}

function makeContext(
  command: string,
  subcommand?: string,
  overrides: Record<string, unknown> = {},
): CliContext {
  return {
    argv: [],
    args: {
      command,
      subcommand,
      json: true,
      tui: false,
      write: false,
      save: false,
      confirmWrite: false,
      interactive: false,
      nonInteractive: false,
      force: false,
      apply: false,
      dryRun: false,
      yes: false,
      schema: false,
      verbose: false,
      vision: false,
      functions: false,
      reset: false,
      runtime: false,
      list: false,
      clean: false,
      safeMode: false,
      strictMode: false,
      ...overrides,
    },
    getConfig: () => ({}) as never,
    getContainer: () => ({}) as never,
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('service command', () => {
  it('prints service status as JSON', async () => {
    const root = makeRuntimeRoot();
    const originalCwd = process.cwd();
    process.chdir(root);
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);

    try {
      const handled = await handleServiceCommand(makeContext('service', 'status'), {
        status: () => ({
          name: 'memphis.service',
          available: true,
          installed: true,
          enabled: true,
          active: true,
          unitPath: '/tmp/memphis.service',
          runtimeRoot: root,
          execStart: '/usr/bin/node dist/infra/cli/index.js serve',
          pathEnv: '/usr/bin',
          detail: 'installed and active',
        }),
        install: vi.fn() as never,
        restart: vi.fn() as never,
        uninstall: vi.fn() as never,
        logs: vi.fn() as never,
      });

      expect(handled).toBe(true);
      const payload = JSON.parse(log.mock.calls[0]?.[0] as string);
      expect(payload.active).toBe(true);
      expect(payload.runtimeRoot).toBe(root);
    } finally {
      process.chdir(originalCwd);
    }
  });

  it('resets runtime state and removes generated files', () => {
    const root = makeRuntimeRoot();
    const dataDir = join(root, 'runtime-data');
    mkdirSync(join(root, '.memphis'), { recursive: true });
    mkdirSync(join(root, 'data'), { recursive: true });
    mkdirSync(join(root, 'undefined', 'chains'), { recursive: true });
    mkdirSync(dataDir, { recursive: true });
    writeFileSync(
      join(root, '.env'),
      'MEMPHIS_DATA_DIR=./runtime-data\nDATABASE_URL=file:./data/memphis.db\nRUST_EMBED_PERSIST_PATH=./data/embed-index.json\n',
    );
    writeFileSync(join(root, 'AGENTS.md'), '# agents\n');
    writeFileSync(join(root, 'CLAUDE.md'), '# claude\n');
    writeFileSync(join(root, 'data/memphis.db'), 'db');
    writeFileSync(join(root, 'data/memphis.db-wal'), 'wal');
    writeFileSync(join(root, 'data/embed-index.json'), '{}');
    writeFileSync(join(root, 'memphis.db'), 'stale-db');
    writeFileSync(join(root, 'memphis.db-wal'), 'stale-wal');
    writeFileSync(join(root, 'embed-index.json'), '{}');
    writeFileSync(join(root, 'undefined', 'chains', 'orphan.json'), '{}');
    writeFileSync(join(dataDir, 'state.json'), '{}');

    const result = resetRuntimeState(
      root,
      { ...process.env, MEMPHIS_DATA_DIR: dataDir },
      {
        uninstall: () => ({
          name: 'memphis.service',
          available: true,
          removed: true,
          unitPath: '/tmp/memphis.service',
          detail: 'service unit removed',
        }),
      },
    );

    expect(result.removed).toContain(join(root, '.env'));
    expect(result.removed).toContain(join(root, 'AGENTS.md'));
    expect(result.removed).toContain(join(root, 'CLAUDE.md'));
    expect(result.removed).toContain(join(root, 'data/memphis.db'));
    expect(result.removed).toContain(join(root, 'data/memphis.db-wal'));
    expect(result.removed).toContain(join(root, 'data/embed-index.json'));
    expect(result.removed).toContain(join(root, 'memphis.db'));
    expect(result.removed).toContain(join(root, 'memphis.db-wal'));
    expect(result.removed).toContain(join(root, 'embed-index.json'));
    expect(result.removed).toContain(join(root, 'undefined'));
    expect(result.removed).toContain(dataDir);
  });
});

describe('user service helpers', () => {
  it('builds a systemd unit that starts the dist serve entrypoint', () => {
    const root = makeRuntimeRoot();
    const unit = buildUserServiceUnit(root, { HOME: '/tmp/home' });

    expect(unit).toContain(`WorkingDirectory=${root}`);
    expect(unit).toContain(
      `ExecStart=${process.execPath} ${join(root, 'dist/infra/cli/index.js')} serve`,
    );
    expect(unit).toContain('Environment=NODE_ENV=development');
    expect(unit).toContain('Restart=on-failure');
    expect(unit).toContain('RestartPreventExitStatus=101 102 103');
  });

  it('requires commands to run from the Memphis runtime root', () => {
    const root = mkdtempSync(join(tmpdir(), 'memphis-non-root-'));
    expect(() => resolveRuntimeRoot(root)).toThrow(/Memphis runtime root/);
  });
});
