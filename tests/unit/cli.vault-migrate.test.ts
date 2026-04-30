/**
 * Unit tests for `memphis vault migrate` (S6).
 *
 * Drives the handler against a tmpdir filesystem so file moves are real but
 * isolated. Exercises: no-legacy, both-files, partial, conflict-with-target,
 * --yes acceptance, JSON output.
 */

import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { CliContext } from '../../src/infra/cli/context.js';
import { vaultCommandHandler } from '../../src/infra/cli/handlers/vault.handler.js';

interface ConsoleSpy {
  log: ReturnType<typeof vi.spyOn>;
  error: ReturnType<typeof vi.spyOn>;
}

let consoleSpy: ConsoleSpy;
let installRoot: string;
let memphisHome: string;
let originalEnv: NodeJS.ProcessEnv;

beforeEach(() => {
  consoleSpy = {
    log: vi.spyOn(console, 'log').mockImplementation(() => undefined),
    error: vi.spyOn(console, 'error').mockImplementation(() => undefined),
  };
  installRoot = mkdtempSync(join(tmpdir(), 'memphis-vault-migrate-install-'));
  memphisHome = mkdtempSync(join(tmpdir(), 'memphis-vault-migrate-home-'));
  // resolveInstallRoot validates MEMPHIS_RUNTIME_ROOT against package.json
  // name "@memphis-chains/memphis" — fake one so the override is accepted.
  writeFileSync(
    join(installRoot, 'package.json'),
    JSON.stringify({ name: '@memphis-chains/memphis' }),
  );
  originalEnv = { ...process.env };
  process.env.MEMPHIS_RUNTIME_ROOT = installRoot;
  // getDataDir reads MEMPHIS_DATA_DIR (MEMPHIS_DIR alias dropped 2026-04-30).
  process.env.MEMPHIS_DATA_DIR = memphisHome;
  // Reset between tests so exit-code assertions don't leak across cases.
  process.exitCode = 0;
});

afterEach(() => {
  consoleSpy.log.mockRestore();
  consoleSpy.error.mockRestore();
  vi.restoreAllMocks();
  rmSync(installRoot, { recursive: true, force: true });
  rmSync(memphisHome, { recursive: true, force: true });
  process.env = originalEnv;
});

function buildContext(opts: {
  argv?: string[];
  json?: boolean;
} = {}): CliContext {
  return {
    argv: opts.argv ?? ['--yes'],
    args: {
      command: 'vault',
      subcommand: 'migrate',
      json: opts.json ?? false,
    } as CliContext['args'],
    getConfig: () => ({}) as ReturnType<CliContext['getConfig']>,
    getContainer: () => ({}) as ReturnType<CliContext['getContainer']>,
  };
}

function writeLegacy(file: string, content: string): string {
  const dir = join(installRoot, 'data');
  mkdirSync(dir, { recursive: true });
  const path = join(dir, file);
  writeFileSync(path, content);
  return path;
}

function writeNew(file: string, content: string): string {
  const path = join(memphisHome, file);
  writeFileSync(path, content);
  return path;
}

describe('memphis vault migrate', () => {
  it('reports no-op when no legacy files exist', async () => {
    await vaultCommandHandler.handle(buildContext({ json: true }));

    const out = consoleSpy.log.mock.calls.map((c) => c[0]).join('\n');
    const parsed = JSON.parse(out);
    expect(parsed.ok).toBe(true);
    expect(parsed.migrated).toBe(0);
    expect(parsed.reason).toBe('no-legacy-vault');
  });

  it('moves both vault files when only legacy exists', async () => {
    writeLegacy('vault-state.json', '{"v":1}');
    writeLegacy('vault-entries.json', '[{"k":"x"}]');

    await vaultCommandHandler.handle(buildContext({ json: true }));

    const out = consoleSpy.log.mock.calls.map((c) => c[0]).join('\n');
    const parsed = JSON.parse(out);
    expect(parsed.ok).toBe(true);
    expect(parsed.migrated).toBe(2);
    expect(parsed.files).toEqual(
      expect.arrayContaining(['vault-state.json', 'vault-entries.json']),
    );

    expect(existsSync(join(installRoot, 'data', 'vault-state.json'))).toBe(false);
    expect(existsSync(join(installRoot, 'data', 'vault-entries.json'))).toBe(false);
    expect(readFileSync(join(memphisHome, 'vault-state.json'), 'utf8')).toBe('{"v":1}');
    expect(readFileSync(join(memphisHome, 'vault-entries.json'), 'utf8')).toBe('[{"k":"x"}]');
  });

  it('moves only the file that exists (partial legacy)', async () => {
    writeLegacy('vault-state.json', '{"v":2}');

    await vaultCommandHandler.handle(buildContext({ json: true }));

    const parsed = JSON.parse(consoleSpy.log.mock.calls.map((c) => c[0]).join('\n'));
    expect(parsed.migrated).toBe(1);
    expect(parsed.files).toEqual(['vault-state.json']);
  });

  it('refuses to clobber when target file already exists', async () => {
    writeLegacy('vault-state.json', '{"legacy":true}');
    writeNew('vault-state.json', '{"new":true}');

    await vaultCommandHandler.handle(buildContext({ json: true }));

    const err = consoleSpy.error.mock.calls.map((c) => c[0]).join('\n');
    expect(err).toContain('refusing to clobber');
    expect(err).toContain('vault-state.json');
    expect(readFileSync(join(memphisHome, 'vault-state.json'), 'utf8')).toBe('{"new":true}');
    expect(readFileSync(join(installRoot, 'data', 'vault-state.json'), 'utf8')).toBe(
      '{"legacy":true}',
    );
    // Codex P2 fix: scripts wrapping `vault migrate` must see a non-zero
    // exit code on conflict refusal, not a silent success.
    expect(process.exitCode).toBe(1);
  });

  it('requires --yes when stdin is not a TTY', async () => {
    writeLegacy('vault-state.json', '{"v":3}');
    const wasIsTTY = process.stdin.isTTY;
    Object.defineProperty(process.stdin, 'isTTY', { value: false, configurable: true });

    try {
      await vaultCommandHandler.handle(buildContext({ argv: [] }));
    } finally {
      Object.defineProperty(process.stdin, 'isTTY', { value: wasIsTTY, configurable: true });
    }

    const err = consoleSpy.error.mock.calls.map((c) => c[0]).join('\n');
    expect(err).toContain('requires --yes');
    expect(existsSync(join(installRoot, 'data', 'vault-state.json'))).toBe(true);
    expect(process.exitCode).toBe(1);
  });
});
