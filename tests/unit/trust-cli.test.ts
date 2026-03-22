/**
 * Unit tests for the trust CLI handler.
 */
import { randomUUID } from 'node:crypto';
import { mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { CliContext } from '../../src/infra/cli/context.js';
import { trustCommandHandler } from '../../src/infra/cli/handlers/trust.handler.js';
import type { CliArgs } from '../../src/infra/cli/types.js';
import { loadSoulManifest, ensureSoulManifest } from '../../src/soul/manifest.js';

function makeTmpDir(): string {
  const dir = join(tmpdir(), `memphis-trust-cli-test-${randomUUID()}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function makeContext(overrides: {
  subcommand?: string;
  target?: string;
  json?: boolean;
  argv?: string[];
}): CliContext {
  const args: CliArgs = {
    command: 'trust',
    subcommand: overrides.subcommand,
    target: overrides.target,
    json: overrides.json ?? true,
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
  };

  return {
    argv: overrides.argv ?? ['trust', overrides.subcommand ?? '', overrides.target ?? ''],
    args,
    getConfig: () => {
      throw new Error('Not needed in trust tests');
    },
    getContainer: () => {
      throw new Error('Not needed in trust tests');
    },
  };
}

describe('trust CLI handler', () => {
  let dataDir: string;
  let previousDataDir: string | undefined;
  const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
  const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

  beforeEach(() => {
    dataDir = makeTmpDir();
    previousDataDir = process.env.MEMPHIS_DATA_DIR;
    process.env.MEMPHIS_DATA_DIR = dataDir;
    process.env.RUST_CHAIN_ENABLED = 'false';
    consoleSpy.mockClear();
    consoleErrorSpy.mockClear();
    // Ensure manifest exists
    ensureSoulManifest();
  });

  afterEach(() => {
    if (previousDataDir !== undefined) {
      process.env.MEMPHIS_DATA_DIR = previousDataDir;
    } else {
      delete process.env.MEMPHIS_DATA_DIR;
    }
    rmSync(dataDir, { recursive: true, force: true });
  });

  it('canHandle recognizes trust command', () => {
    const ctx = makeContext({ subcommand: 'list' });
    expect(trustCommandHandler.canHandle(ctx)).toBe(true);
  });

  it('list shows empty rules initially', async () => {
    const ctx = makeContext({ subcommand: 'list' });
    await trustCommandHandler.handle(ctx);

    const output = consoleSpy.mock.calls[0]?.[0] as string;
    const parsed = JSON.parse(output);
    expect(parsed.mode).toBe('balanced');
    expect(parsed.trustRules).toEqual([]);
  });

  it('add creates a trust rule with auto-approve', async () => {
    const ctx = makeContext({
      subcommand: 'add',
      target: 'memphis_web_fetch',
      argv: ['trust', 'add', 'memphis_web_fetch', '--auto-approve'],
    });
    await trustCommandHandler.handle(ctx);

    const output = consoleSpy.mock.calls[0]?.[0] as string;
    const parsed = JSON.parse(output);
    expect(parsed.added.tool).toBe('memphis_web_fetch');
    expect(parsed.added.autoApprove).toBe(true);

    // Verify persisted
    const manifest = loadSoulManifest();
    expect(manifest?.trustRules).toHaveLength(1);
    expect(manifest?.trustRules[0].tool).toBe('memphis_web_fetch');
  });

  it('add creates a trust rule without auto-approve', async () => {
    const ctx = makeContext({
      subcommand: 'add',
      target: 'memphis_exec',
      argv: ['trust', 'add', 'memphis_exec'],
    });
    await trustCommandHandler.handle(ctx);

    const output = consoleSpy.mock.calls[0]?.[0] as string;
    const parsed = JSON.parse(output);
    expect(parsed.added.autoApprove).toBe(false);
  });

  it('add replaces existing rule for same tool', async () => {
    // Add first
    await trustCommandHandler.handle(
      makeContext({
        subcommand: 'add',
        target: 'memphis_web_fetch',
        argv: ['trust', 'add', 'memphis_web_fetch'],
      }),
    );

    // Add again with auto-approve
    consoleSpy.mockClear();
    await trustCommandHandler.handle(
      makeContext({
        subcommand: 'add',
        target: 'memphis_web_fetch',
        argv: ['trust', 'add', 'memphis_web_fetch', '--auto-approve'],
      }),
    );

    const manifest = loadSoulManifest();
    expect(manifest?.trustRules).toHaveLength(1);
    expect(manifest?.trustRules[0].autoApprove).toBe(true);
  });

  it('add rejects unknown tools', async () => {
    const ctx = makeContext({
      subcommand: 'add',
      target: 'unknown_tool',
      argv: ['trust', 'add', 'unknown_tool'],
    });
    await trustCommandHandler.handle(ctx);

    const output = consoleErrorSpy.mock.calls[0]?.[0] as string;
    expect(output).toContain('Unknown tool');
  });

  it('add accepts wildcard *', async () => {
    const ctx = makeContext({
      subcommand: 'add',
      target: '*',
      argv: ['trust', 'add', '*', '--auto-approve'],
    });
    await trustCommandHandler.handle(ctx);

    const output = consoleSpy.mock.calls[0]?.[0] as string;
    const parsed = JSON.parse(output);
    expect(parsed.added.tool).toBe('*');
  });

  it('remove deletes a trust rule', async () => {
    // Add first
    await trustCommandHandler.handle(
      makeContext({
        subcommand: 'add',
        target: 'memphis_web_fetch',
        argv: ['trust', 'add', 'memphis_web_fetch', '--auto-approve'],
      }),
    );

    // Remove
    consoleSpy.mockClear();
    await trustCommandHandler.handle(
      makeContext({
        subcommand: 'remove',
        target: 'memphis_web_fetch',
      }),
    );

    const output = consoleSpy.mock.calls[0]?.[0] as string;
    const parsed = JSON.parse(output);
    expect(parsed.removed).toBe(true);

    const manifest = loadSoulManifest();
    expect(manifest?.trustRules).toHaveLength(0);
  });

  it('remove reports when no rule found', async () => {
    const ctx = makeContext({
      subcommand: 'remove',
      target: 'memphis_web_fetch',
    });
    await trustCommandHandler.handle(ctx);

    const output = consoleSpy.mock.calls[0]?.[0] as string;
    const parsed = JSON.parse(output);
    expect(parsed.removed).toBe(false);
  });

  it('mode shows current mode', async () => {
    const ctx = makeContext({ subcommand: 'mode' });
    await trustCommandHandler.handle(ctx);

    const output = consoleSpy.mock.calls[0]?.[0] as string;
    const parsed = JSON.parse(output);
    expect(parsed.mode).toBe('balanced');
  });

  it('mode set changes mode', async () => {
    const ctx = makeContext({
      subcommand: 'mode',
      target: 'set',
      argv: ['trust', 'mode', 'set', 'paranoid'],
    });
    await trustCommandHandler.handle(ctx);

    const output = consoleSpy.mock.calls[0]?.[0] as string;
    const parsed = JSON.parse(output);
    expect(parsed.mode).toBe('paranoid');

    const manifest = loadSoulManifest();
    expect(manifest?.mode).toBe('paranoid');
  });

  it('mode set rejects invalid mode', async () => {
    const ctx = makeContext({
      subcommand: 'mode',
      target: 'set',
      argv: ['trust', 'mode', 'set', 'invalid'],
    });
    await trustCommandHandler.handle(ctx);

    const output = consoleErrorSpy.mock.calls[0]?.[0] as string;
    expect(output).toContain('Usage');
  });
});
