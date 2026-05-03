/**
 * TUI binary smoke + CLI-contract test.
 *
 * Closes the gap surfaced by the 2026-05-03 runtime audit: the Rust
 * `memphis-tui` binary boots end-to-end at runtime but no integration
 * test asserted that its CLI surface (`--check-only`, `--json`,
 * `--run-command`, `--help`) stays stable. A drift like "renamed
 * `--check-only` to `--introspect`" would only have been caught in
 * production since `tests/unit/rust-tui-launcher.test.ts` mocks
 * `child_process.spawn` and never executes the real binary.
 *
 * This test resolves the binary at `target/{debug,release}/memphis-tui`
 * (whichever exists) and exec's it with each documented flag combo,
 * asserting exit code + JSON shape. If neither binary path exists
 * (fresh checkout without `npm run build:rust`), the test SKIPS with
 * a clear diagnostic instead of failing — CI builds the workspace
 * before tests so the binary will be present there.
 */
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

function resolveTuiBinary(): string | null {
  const repoRoot = resolve(__dirname, '../..');
  const candidates = [
    resolve(repoRoot, 'target/debug/memphis-tui'),
    resolve(repoRoot, 'target/release/memphis-tui'),
  ];
  return candidates.find((p) => existsSync(p)) ?? null;
}

interface ExecResult {
  stdout: string;
  stderr: string;
  status: number;
}

function runBinary(binary: string, args: readonly string[]): ExecResult {
  try {
    const stdout = execFileSync(binary, args, {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 15_000,
    });
    return { stdout: String(stdout), stderr: '', status: 0 };
  } catch (err) {
    const e = err as NodeJS.ErrnoException & {
      stdout?: Buffer | string;
      stderr?: Buffer | string;
      status?: number;
    };
    return {
      stdout: e.stdout ? e.stdout.toString() : '',
      stderr: e.stderr ? e.stderr.toString() : '',
      status: typeof e.status === 'number' ? e.status : -1,
    };
  }
}

const BINARY = resolveTuiBinary();

describe.skipIf(BINARY === null)('memphis-tui binary smoke + CLI contract', () => {
  // BINARY is non-null inside this block per .skipIf above.
  const bin = BINARY as string;

  it('--help prints usage and exits 0 (no panic on a fresh process)', () => {
    const result = runBinary(bin, ['--help']);
    expect(result.status, `--help exited ${result.status}\n${result.stderr}`).toBe(0);
    expect(result.stdout).toContain('memphis-tui');
    expect(result.stdout).toContain('--check-only');
    expect(result.stdout).toContain('--json');
    expect(result.stdout).toContain('--run-command');
  });

  it('--check-only --json emits the expected check-only JSON envelope', () => {
    const result = runBinary(bin, ['--check-only', '--json']);
    expect(result.status, `--check-only --json exited ${result.status}\n${result.stderr}`).toBe(0);

    const parsed = JSON.parse(result.stdout) as {
      mode: string;
      uiMode: string;
      rendererMode: string;
      ok: boolean;
      surfaces: string[];
      provider_status_count: number;
      chat_session_id: string;
    };

    expect(parsed.mode).toBe('check-only');
    expect(parsed.uiMode).toBe('single-view');
    expect(parsed.rendererMode).toBe('ratatui');
    expect(parsed.ok).toBe(true);
    expect(Array.isArray(parsed.surfaces)).toBe(true);
    // 7 documented TUI screens per atlas: Overview / Chat / Memory /
    // Sessions / Vault / Cases / System. If a screen is added, this
    // contract should be updated deliberately.
    expect(parsed.surfaces).toEqual([
      'Overview',
      'Chat',
      'Memory',
      'Sessions',
      'Vault',
      'Cases',
      'System',
    ]);
    expect(typeof parsed.provider_status_count).toBe('number');
    expect(typeof parsed.chat_session_id).toBe('string');
  });

  it('rejects --check-only and --run-command used together (exit 2)', () => {
    const result = runBinary(bin, ['--check-only', '--run-command', 'help', '--json']);
    expect(result.status).toBe(2);
    expect(result.stderr).toContain('--check-only and --run-command cannot be used together');
  });

  it('rejects --run-command without --json (exit 2)', () => {
    const result = runBinary(bin, ['--run-command', 'help']);
    expect(result.status).toBe(2);
    expect(result.stderr).toContain('--run-command requires --json');
  });

  it('rejects an unknown flag (exit 2 with diagnostic on stderr)', () => {
    const result = runBinary(bin, ['--no-such-flag']);
    expect(result.status).toBe(2);
    expect(result.stderr).toContain('unsupported memphis-tui flag');
  });
});
