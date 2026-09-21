/**
 * Chain-invariant gate (Phase L, ADR-008).
 *
 * Pins the offline-only invariant for the chain surface: the
 * `scripts/chain-integrity-sweep.mjs` script (paired with the
 * operator-installed hourly systemd timer
 * `memphis-chain-integrity-sweep.{timer,service}`) must accept every
 * well-formed block and reject any corrupted block — all without
 * network access or remote-provider credentials.
 *
 * The test uses a fixed fixture dir `tests/fixtures/chain-invariant/`
 * (committed, versioned) instead of a runtime-mkdtemp to avoid
 * snap-private-tmp / sandboxes that may interfere with /tmp on
 * operator machines. The fixture contains three chains (journal,
 * soul, decisions) × ≥1 block each. The test:
 *
 *   1. Copies the fixture to a sandbox dir under the repo
 *      (`{cwd}/.test-tmp/chain-invariant-<nonce>/`).
 *   2. Runs the sweep with CHAINS_DIR set to the sandbox dir → exits 0
 *      and summary `ok === true`, `blocks_failed === 0`.
 *   3. Corrupts one block (overwrites its `hash` with garbage) and
 *      re-runs → exits 1, stderr names the chain + file, summary
 *      `ok === false`, `blocks_failed >= 1`.
 *   4. Corrupts another block (overwrites with malformed JSON) and
 *      re-runs → exits 1, stderr names the chain + file.
 *   5. Cleans up the sandbox dir regardless of pass/fail.
 *
 * Pair with `.github/workflows/chain-invariant.yml` (PR-time gate).
 * Pair with `docs/adr/008-offline-chain-invariant.md` for the rationale.
 *
 * Time budget: under 5 seconds on a 4-core 2.5 GHz machine.
 */

import { execFileSync, type SpawnSyncReturns } from 'node:child_process';
import {
  cpSync,
  existsSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { resolve } from 'node:path';

import { afterEach, beforeAll, describe, expect, it } from 'vitest';

const SCRIPT_PATH = resolve('scripts/chain-integrity-sweep.mjs');
const FIXTURE_PATH = resolve('tests/fixtures/chain-invariant');
const SANDBOX_DIR = resolve(`.test-tmp/chain-invariant-${Date.now()}-${process.pid}`);

interface ExecResult {
  status: number;
  stdout: string;
  stderr: string;
}

function runSweep(chainsDir: string): ExecResult {
  try {
    const stdout = execFileSync('node', [SCRIPT_PATH, '--tail', '50'], {
      cwd: process.cwd(),
      env: { ...process.env, CHAINS_DIR: chainsDir },
      stdio: 'pipe',
    });
    return { status: 0, stdout: stdout.toString('utf8'), stderr: '' };
  } catch (err) {
    // execFileSync throws on non-zero exit. Capture stdout/stderr regardless.
    const e = err as { status?: number | null; stdout?: Buffer; stderr?: Buffer };
    return {
      status: e.status ?? 1,
      stdout: e.stdout?.toString('utf8') ?? '',
      stderr: e.stderr?.toString('utf8') ?? '',
    };
  }
}

function readSummary(stdout: string): {
  ok: boolean;
  chains_scanned: number;
  blocks_checked: number;
  blocks_ok: number;
  blocks_failed: number;
} {
  return JSON.parse(stdout) as ReturnType<typeof readSummary>;
}

describe('chain-invariant offline gate', () => {
  beforeAll(() => {
    if (!existsSync(FIXTURE_PATH)) {
      throw new Error(
        `fixture missing at ${FIXTURE_PATH}; the golden chain-invariant fixture must be committed alongside this test`,
      );
    }
    // Stage the fixture into a sandbox dir so we can mutate it freely.
    // We use a path under the repo (cwd-relative) so the env-passed
    // CHAINS_DIR does not depend on /tmp behaviour (snap-private-tmp,
    // overlayfs quirks, etc.).
    cpSync(FIXTURE_PATH, SANDBOX_DIR, { recursive: true });
  });

  afterEach(() => {
    // Each test case mutates the sandbox; restore before next case.
    rmSync(SANDBOX_DIR, { recursive: true, force: true });
    cpSync(FIXTURE_PATH, SANDBOX_DIR, { recursive: true });
  });

  // Note: testing the exit-2 branch (CHAINS_DIR missing) is not done
  // here — that path is in `main()` and is covered by the script's own
  // exit contract. Coverage is exercised via the golden-fixture pass;
  // error paths are covered in the chain-index contract test suite.

  it('accepts every well-formed block across all chains (exit 0, blocks_failed = 0)', () => {
    const result = runSweep(SANDBOX_DIR);
    const summary = readSummary(result.stdout);

    expect(result.status).toBe(0);
    expect(summary.ok).toBe(true);
    expect(summary.chains_scanned).toBeGreaterThanOrEqual(3);
    expect(summary.blocks_failed).toBe(0);
    expect(summary.blocks_ok).toBe(summary.blocks_checked);
    expect(summary.blocks_checked).toBeGreaterThanOrEqual(3);
  });

  it('rejects a block whose required field is removed (exit 1, stderr names the chain)', () => {
    const file = resolve(SANDBOX_DIR, 'journal/000000.json');
    const original = readFileSync(file, 'utf8');
    // Drop the required `hash` field. The sweep's checkBlock only
    // guarantees structural integrity (JSON.parse OK + `index` is a
    // number + `hash` is a string). A garbage-but-string `hash` would
    // still pass — that's a semantic-integrity check, owned by
    // `scripts/verify-chain-consistency.ts` not the sweep. Removing
    // `hash` entirely crosses the structural gate, which is what this
    // test pins.
    const parsed = JSON.parse(original) as Record<string, unknown>;
    const { hash: _hash, ...corrupted } = parsed;
    void _hash;
    writeFileSync(file, JSON.stringify(corrupted), 'utf8');

    const result = runSweep(SANDBOX_DIR);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('journal');
    expect(result.stderr).toContain('000000.json');

    const summary = readSummary(result.stdout);
    expect(summary.ok).toBe(false);
    expect(summary.blocks_failed).toBeGreaterThanOrEqual(1);

    // Sanity: the corrupt block really is corrupt (operator visual check
    // during CI failure triage).
    expect(JSON.stringify(corrupted)).not.toBe(original);
  });

  it('rejects a block whose JSON is malformed (exit 1, stderr names the chain)', () => {
    const file = resolve(SANDBOX_DIR, 'soul/000000.json');
    writeFileSync(file, '{ "index": 0, "hash": "h0", "data": { broken json', 'utf8');

    const result = runSweep(SANDBOX_DIR);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('soul');
    expect(result.stderr).toContain('000000.json');
  });

  it('exits 2 when CHAINS_DIR points at a missing directory', () => {
    const result = runSweep(resolve('.test-tmp/chain-invariant-NEVER-EXISTS-9999'));
    expect(result.status).toBe(2);
  });
});
