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
 * This test measures the GENERATOR (`dashboard_report.render`), because
 * that is what the contract test runs and what used to probe one URL
 * after another. Measuring the helper alone was not enough: the
 * generator had its own loop, and a mutation that restored that loop
 * passed a helper-only test.
 *
 * The probe timeout is scaled down to 1 second here (production uses 8).
 * The ratio is what matters: sequential probing costs 22 x 1 s = 22 s,
 * concurrent probing costs ceil(22 / 8) x 1 s = 3 s, and the bound below
 * sits between them. The test therefore still fails on a sequential
 * implementation, in seconds instead of minutes, and it does not depend
 * on how fast the runner happens to be.
 */

const repoRoot = resolve(new URL('../..', import.meta.url).pathname);
const scripts = join(repoRoot, 'scripts');

it('generates the dashboard in parallel — the worst case stays far below the hook limit', () => {
  const root = mkdtempSync(join(tmpdir(), 'memphis-probe-parallel-'));
  try {
    const script = join(root, 'measure.py');
    writeFileSync(
      script,
      [
        'import sys, time',
        `sys.path.insert(0, ${JSON.stringify(scripts)})`,
        'import dashboard_probes as dp',
        '# Every probe points at an address that never answers:',
        '# each one burns its full timeout.',
        'dp.ALL_PROBES = [f"https://10.255.255.1/probe-{i}" for i in range(22)]',
        '# Scaled down from the production 8 s: the ratio is what matters.',
        'dp.TIMEOUT_SECONDS = 1',
        'import dashboard_report as dr',
        'dr.ALL_PROBES = dp.ALL_PROBES',
        '# The generator itself, not the helper: the generator had its own',
        '# sequential loop, and a helper-only test did not catch it.',
        'started = time.time()',
        'html = dr.render("internal")',
        'elapsed = time.time() - started',
        'print(f"{len(html)} {elapsed:.1f}")',
      ].join('\n'),
    );

    const output = execFileSync('python3', [script], {
      cwd: repoRoot,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 60_000,
    }).trim();

    const [htmlLength, elapsedText] = output.split(' ');
    const elapsedMs = Number(elapsedText) * 1000;

    expect(Number(htmlLength), 'the generator must still produce a dashboard').toBeGreaterThan(0);
    // Sequential probing costs 22 x 1 s = 22 s at the scaled timeout;
    // concurrent probing costs ceil(22 / 8) x 1 s = 3 s. The bound sits
    // between the two, so a sequential implementation fails here and a
    // concurrent one passes with room to spare on a slow runner.
    expect(elapsedMs).toBeLessThan(12_000);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}, 120_000);
