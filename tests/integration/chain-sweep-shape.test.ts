import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

/**
 * Chain-shape anomalies — the gap that let 2026-10-07 19:00 look healthy.
 *
 * The sweep counted directories (`chains_scanned = readdir().length`) and
 * reported `ok: true` regardless of whether those directories held any
 * blocks. Real evidence: at 19:00 the hourly sweep logged
 * `chains_scanned: 3, blocks_ok: 7, ok: true` while 15:00 and every one
 * of the other 176 runs that week logged `chains_scanned: 14`. A
 * disappearing chain directory was indistinguishable from a quiet hour.
 *
 * These tests use a tmpdir sandbox, not the operator's real chains, and
 * run in ~100 ms — no daemon, no secrets, no network.
 */
const SCRIPT_PATH = resolve('scripts/chain-integrity-sweep.mjs');

interface ExecResult {
  status: number;
  stdout: string;
  stderr: string;
}

interface Summary {
  ok: boolean;
  chains_scanned: number;
  chains_with_blocks: number;
  chains_empty: string[];
  chains_vanished: string[];
  chains_nested_only: string[];
  blocks_ok: number;
  blocks_failed: number;
}

/**
 * The sweep takes its chain list once, then reads each chain's blocks. To
 * reach the vanished branch we need a directory that disappears in
 * between. `SWEEP_DELETE_AFTER_LIST` lets the child process do the removal
 * at exactly that point, so the test drives the real race instead of
 * guessing at it.
 */
function runSweep(chainsDir: string, options: { afterList?: string } = {}): ExecResult {
  try {
    const stdout = execFileSync('node', [SCRIPT_PATH], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        CHAINS_DIR: chainsDir,
        ...(options.afterList ? { SWEEP_DELETE_AFTER_LIST: options.afterList } : {}),
      },
      stdio: 'pipe',
    });
    return { status: 0, stdout: stdout.toString('utf8'), stderr: '' };
  } catch (err) {
    const e = err as { status?: number | null; stdout?: Buffer; stderr?: Buffer };
    return {
      status: e.status ?? 1,
      stdout: e.stdout?.toString('utf8') ?? '',
      stderr: e.stderr?.toString('utf8') ?? '',
    };
  }
}

function readSummary(stdout: string): Summary {
  return JSON.parse(stdout) as Summary;
}

/** Minimal well-formed block: the sweep only checks `index` and `hash`. */
function writeBlock(chainDir: string, index: number): void {
  mkdirSync(chainDir, { recursive: true });
  writeFileSync(
    join(chainDir, `00000${index}.json`),
    JSON.stringify({ index, hash: `h${index}`, timestamp: '2026-10-08T00:00:00Z' }),
  );
}

const sandboxes: string[] = [];

function sandbox(): string {
  const dir = mkdtempSync(join(tmpdir(), 'sweep-shape-'));
  sandboxes.push(dir);
  return dir;
}

afterEach(() => {
  while (sandboxes.length > 0) {
    const dir = sandboxes.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

describe('chain sweep reports chain-shape anomalies', () => {
  it('passes when every chain directory holds blocks', () => {
    const dir = sandbox();
    writeBlock(join(dir, 'journal'), 1);
    writeBlock(join(dir, 'decisions'), 1);

    const result = runSweep(dir);

    expect(result.status).toBe(0);
    const summary = readSummary(result.stdout);
    expect(summary.ok).toBe(true);
    expect(summary.chains_empty).toEqual([]);
    expect(summary.chains_vanished).toEqual([]);
  });

  // Regression net for the 19:00 shape: an empty chain used to be
  // invisible, because `ok` depended only on parse failures.
  it('flags an empty chain directory as a shape anomaly (exit 3)', () => {
    const dir = sandbox();
    writeBlock(join(dir, 'journal'), 1);
    mkdirSync(join(dir, 'system'), { recursive: true }); // exists, zero blocks

    const result = runSweep(dir);

    expect(result.status).toBe(3);
    const summary = readSummary(result.stdout);
    expect(summary.ok).toBe(false);
    expect(summary.chains_empty).toEqual(['system']);
    // The healthy chain is still reported, not swallowed by the failure.
    expect(summary.blocks_ok).toBe(1);
    expect(result.stderr).toContain('chain_shape');
  });

  it('treats a container with nested blocks as healthy, not empty', () => {
    const dir = sandbox();
    writeBlock(join(dir, 'journal'), 1);
    // `_quarantine` holds blocks one level down, named without a `000`
    // prefix. Counting only the checked path would flag 403 real blocks
    // as a data-loss anomaly every hour.
    mkdirSync(join(dir, '_quarantine', 'patterns-orphan'), { recursive: true });
    writeFileSync(
      join(dir, '_quarantine', 'patterns-orphan', '003592.json'),
      JSON.stringify({ index: 3592, hash: 'hx', timestamp: '2026-10-08T00:00:00Z' }),
    );

    const result = runSweep(dir);

    expect(result.status).toBe(0);
    const summary = readSummary(result.stdout);
    expect(summary.ok).toBe(true);
    expect(summary.chains_empty).toEqual([]);
    expect(summary.chains_nested_only).toEqual(['_quarantine']);
  });

  // A symlink is not `isDirectory()` in `readdir(withFileTypes)`, so the
  // vanished branch needs a real race: the directory exists when the
  // chain list is taken, and is gone by the time its blocks are read.
  // Removing it before `runSweep` would make it invisible to `readdir`
  // entirely — which is why the sweep cannot detect that case at all.
  it('reports a vanished directory separately from an empty one', () => {
    const dir = sandbox();
    writeBlock(join(dir, 'journal'), 1);
    writeBlock(join(dir, 'system'), 1);

    const result = runSweep(dir, {
      // Delete the directory after the chain list is read, before blocks.
      afterList: join(dir, 'system'),
    });

    const summary = readSummary(result.stdout);
    expect(summary.chains_vanished).toEqual(['system']);
    expect(summary.chains_empty).toEqual([]);
    expect(summary.ok).toBe(false);
    expect(result.status).toBe(3);
  });

  it('still prefers exit 1 when a block fails to parse', () => {
    const dir = sandbox();
    mkdirSync(join(dir, 'journal'), { recursive: true });
    writeFileSync(join(dir, 'journal', '000001.json'), '{ not json');

    const result = runSweep(dir);

    expect(result.status).toBe(1);
    expect(readSummary(result.stdout).blocks_failed).toBe(1);
  });
});
