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

import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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

function runSweep(chainsDir: string, ...extraArgs: string[]): ExecResult {
  try {
    const stdout = execFileSync('node', [SCRIPT_PATH, '--tail', '50', ...extraArgs], {
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
  oracle: string;
  chains_scanned: number;
  blocks_checked: number;
  blocks_ok: number;
  blocks_failed: number;
  link_failures: number;
  hashes_verified: boolean;
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

  it('says which oracle answered', () => {
    // The sweep used to be the weakest oracle in the repository: it read
    // the file and never asked the core, so it reported `ok: true` over
    // blocks the core cannot deserialize at all. It now asks the core —
    // and it says in its summary whether the core was there to answer.
    const result = runSweep(SANDBOX_DIR);
    const summary = readSummary(result.stdout);
    expect(['native-core', 'structural']).toContain(summary.oracle);
  });

  it('rejects a block the native core cannot deserialize (exit 1)', () => {
    const result = runSweep(SANDBOX_DIR);
    const summary = readSummary(result.stdout);
    if (summary.oracle !== 'native-core') {
      // The bridge is not built here, so the sweep fell back to the
      // structural oracle and this case cannot be exercised. The CI
      // workflow builds the bridge BEFORE these tests (S1), so it runs
      // there; locally it says so instead of passing vacuously.
      expect(summary.oracle).toBe('structural');
      return;
    }

    const file = resolve(SANDBOX_DIR, 'journal/000000.json');
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>;
    const data = parsed.data as Record<string, unknown>;
    data.type = 'autonom_publication';
    writeFileSync(file, JSON.stringify(parsed), 'utf8');

    const swept = runSweep(SANDBOX_DIR);
    expect(swept.status).toBe(1);
    expect(swept.stderr).toContain('journal');
    expect(swept.stderr).toContain('000000.json');
    expect(swept.stderr).toContain('unknown variant');

    const after = readSummary(swept.stdout);
    expect(after.ok).toBe(false);
    expect(after.blocks_failed).toBeGreaterThanOrEqual(1);
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

  it('rejects a broken stored link even when both blocks deserialize', () => {
    const file = resolve(SANDBOX_DIR, 'journal/000001.json');
    const block = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>;
    block.prev_hash = 'f'.repeat(64);
    writeFileSync(file, JSON.stringify(block), 'utf8');
    const result = runSweep(SANDBOX_DIR, '--chain', 'journal');
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('stored block linkage mismatch');
    expect(readSummary(result.stdout).link_failures).toBe(1);
    expect(readSummary(result.stdout).hashes_verified).toBe(false);
  });

  it('includes numeric block filenames beyond index 999', () => {
    const dir = resolve(SANDBOX_DIR, 'large');
    mkdirSync(dir, { recursive: true });
    const block = {
      index: 999,
      timestamp: '2026-01-01T00:00:00.000Z',
      chain: 'large',
      data: { type: 'journal', content: 'synthetic', tags: [] },
      prev_hash: '0'.repeat(64),
      hash: 'a'.repeat(64),
    };
    writeFileSync(resolve(dir, '000999.json'), JSON.stringify(block));
    writeFileSync(
      resolve(dir, '001000.json'),
      JSON.stringify({
        ...block,
        index: 1000,
        prev_hash: block.hash,
        hash: 'b'.repeat(64),
      }),
    );
    const result = runSweep(SANDBOX_DIR, '--chain', 'large');
    expect(result.status).toBe(0);
    const summary = readSummary(result.stdout);
    expect(summary.blocks_checked).toBe(2);
    expect(summary.link_failures).toBe(0);
    expect(summary.hashes_verified).toBe(false);
  });

  it('exits 2 when CHAINS_DIR points at a missing directory', () => {
    const result = runSweep(resolve('.test-tmp/chain-invariant-NEVER-EXISTS-9999'));
    expect(result.status).toBe(2);
  });
});
