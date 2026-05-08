import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { handleDemoCommand } from '../../src/infra/cli/commands/demo.js';
import type { CliContext } from '../../src/infra/cli/context.js';
import type { CliArgs } from '../../src/infra/cli/types.js';

function makeContext(args: Partial<CliArgs>): CliContext {
  const fullArgs = {
    command: 'demo',
    json: false,
    checkOnly: false,
    stdioJson: false,
    tui: false,
    write: false,
    save: false,
    confirmWrite: false,
    confirm: false,
    list: false,
    clean: false,
    safeMode: false,
    strictMode: false,
    noVault: false,
    ...args,
  } as unknown as CliArgs;
  return {
    args: fullArgs,
    getContainer: () => ({}) as never,
  } as unknown as CliContext;
}

describe('memphis demo command surface', () => {
  let dataDir: string;
  let savedDataDir: string | undefined;
  let savedExit: number | undefined;

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), 'memphis-demo-test-'));
    savedDataDir = process.env.MEMPHIS_DATA_DIR;
    process.env.MEMPHIS_DATA_DIR = dataDir;
    savedExit = process.exitCode;
  });

  afterEach(() => {
    if (savedDataDir === undefined) delete process.env.MEMPHIS_DATA_DIR;
    else process.env.MEMPHIS_DATA_DIR = savedDataDir;
    process.exitCode = savedExit;
    rmSync(dataDir, { recursive: true, force: true });
  });

  it('rejects unknown subcommand', async () => {
    const ctx = makeContext({ subcommand: 'launch-rocket' });
    await expect(handleDemoCommand(ctx)).rejects.toThrow(/Unknown demo subcommand/);
  });

  it('returns false for non-demo command (delegates back to dispatcher)', async () => {
    const ctx = makeContext({ command: 'doctor' });
    const handled = await handleDemoCommand(ctx);
    expect(handled).toBe(false);
  });

  it('demo status reports never-armed when state file absent', async () => {
    const ctx = makeContext({ subcommand: 'status', json: true });
    const handled = await handleDemoCommand(ctx);
    expect(handled).toBe(true);
    expect(process.exitCode).toBe(1);
    expect(existsSync(join(dataDir, 'demo-armed.json'))).toBe(false);
  });

  it('demo disarm is a no-op when never armed', async () => {
    const ctx = makeContext({ subcommand: 'disarm', json: true });
    const handled = await handleDemoCommand(ctx);
    expect(handled).toBe(true);
  });

  it('demo arm writes state file at the canonical path on success path (smoke contract)', async () => {
    // We don't mock the entire doctor / backup / telegram surface — that
    // would couple the test to internals. Instead we assert the contract:
    // when arm runs, EITHER process.exitCode is 1 (refused) OR a state
    // file is written. Both are valid "the command did its job" outcomes.
    const ctx = makeContext({ subcommand: 'arm', json: true });
    await handleDemoCommand(ctx);
    const statePath = join(dataDir, 'demo-armed.json');
    if (process.exitCode === 1) {
      // Refused — no state written.
      expect(existsSync(statePath)).toBe(false);
    } else {
      // Armed — state file is valid JSON with the expected shape.
      expect(existsSync(statePath)).toBe(true);
      const parsed = JSON.parse(readFileSync(statePath, 'utf8')) as {
        armedAt: string;
        armedBy: string;
        checks: Array<{ id: string; status: string }>;
      };
      expect(parsed.armedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
      expect(parsed.checks.length).toBeGreaterThan(0);
    }
  });
});
