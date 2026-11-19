import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { expect, it } from 'vitest';

/**
 * The dashboard probes must not be able to outlast the hook that generates
 * the dashboard.
 *
 * Measured 2026-11-19: the probes ran one after another, each with an
 * 8 second timeout, so the worst case was 22 x 8 = 176 seconds. The
 * contract test that generates the dashboard allows 180 seconds for the
 * whole hook — on a CI runner the probes ran past it and the test file
 * failed with "Hook timed out in 180000ms", so nothing about the
 * dashboard was checked at all.
 *
 * This test measures the worst case directly: every probe pointed at an
 * address that never answers, so every probe burns its full timeout.
 */

const repoRoot = resolve(new URL('../..', import.meta.url).pathname);

/** The hook limit in `dashboard-live-contract.test.ts` (beforeAll, 180_000). */
const HOOK_LIMIT_MS = 180_000;

it('probes concurrently — the worst case stays far below the hook limit', () => {
  const root = mkdtempSync(join(tmpdir(), 'memphis-probe-parallel-'));
  try {
    const script = join(root, 'measure.py');
    writeFileSync(
      script,
      [
        'import sys, time',
        `sys.path.insert(0, ${JSON.stringify(join(repoRoot, 'scripts'))})`,
        'import dashboard_probes as dp',
        '# Every probe points at an address that never answers:',
        '# each one burns its full timeout.',
        'dp.ALL_PROBES = [f"https://10.255.255.1/probe-{i}" for i in range(22)]',
        'dp.TIMEOUT_SECONDS = 8',
        'started = time.time()',
        'rows = dp.probe_all()',
        'elapsed = time.time() - started',
        'print(f"{len(rows)} {elapsed:.1f}")',
      ].join('\n'),
    );

    const output = execFileSync('python3', [script], {
      cwd: repoRoot,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: HOOK_LIMIT_MS,
    }).trim();

    const [rowCount, elapsedText] = output.split(' ');
    const elapsedMs = Number(elapsedText) * 1000;

    expect(Number(rowCount), 'every probe must still produce a row').toBe(22);
    // The sequential worst case was 176 s. A generous bound still fails
    // the sequential implementation by a wide margin, and still passes with
    // room to spare on a slow runner.
    expect(elapsedMs).toBeLessThan(HOOK_LIMIT_MS / 2);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
