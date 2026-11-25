/**
 * The boot-failure gate — a runtime that is crash-looping must not keep
 * starting.
 *
 * Postmortem item B3 (docs/postmortems/2026-09-22-chains-halt-invalid-block-shape.md):
 * "`memphis doctor` should refuse `start` when `boot-failures.json` had > 5
 * entries in the last 10 minutes. Currently the service keeps restarting
 * regardless of the JSON file that exists exactly for this purpose."
 *
 * MEASURED that day: 50+ failed restarts in three minutes, every ~5 s,
 * and the counter grew to 50 entries while the service kept restarting.
 *
 * What has to hold:
 *   - a clean runtime starts;
 *   - a runtime that fails five times in the window still starts (the
 *     threshold is MORE than five);
 *   - a runtime that fails six times in the window refuses, and says
 *     where the counter lives so the operator can clear it;
 *   - failures that fell out of the window do not count;
 *   - a counter file that cannot be read is not evidence of a crash loop.
 */
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  BOOT_FAILURE_GATE_THRESHOLD,
  BOOT_FAILURE_GATE_WINDOW_MS,
  describeBootFailureGate,
  evaluateBootFailureGate,
} from '../../src/infra/runtime/boot-failure-gate.js';
import { bootFailurePath, recordBootAttempt } from '../../src/infra/runtime/self-modify-revert.js';

function sandbox(): { rawEnv: NodeJS.ProcessEnv; counterPath: string } {
  const dir = mkdtempSync(join(tmpdir(), 'memphis-boot-gate-'));
  const rawEnv = { MEMPHIS_DATA_DIR: dir } as NodeJS.ProcessEnv;
  return { rawEnv, counterPath: bootFailurePath(rawEnv) };
}

function writeFailures(counterPath: string, timestamps: string[]): void {
  mkdirSync(dirname(counterPath), { recursive: true });
  writeFileSync(
    counterPath,
    JSON.stringify({ failures: timestamps.map((at) => ({ at })) }),
    'utf8',
  );
}

describe('boot-failure gate', () => {
  it('a runtime with no counter starts', () => {
    const { rawEnv } = sandbox();
    const decision = evaluateBootFailureGate(rawEnv);
    expect(decision.refuseStart).toBe(false);
    expect(decision.failuresInWindow).toBe(0);
  });

  it('five failures in the window still start — the threshold is MORE than five', () => {
    const { rawEnv, counterPath } = sandbox();
    const now = new Date('2026-11-25T12:00:00.000Z');
    const failures = Array.from({ length: BOOT_FAILURE_GATE_THRESHOLD }, (_, index) =>
      new Date(now.getTime() - index * 1000).toISOString(),
    );
    writeFailures(counterPath, failures);

    const decision = evaluateBootFailureGate(rawEnv, now);
    expect(decision.failuresInWindow).toBe(BOOT_FAILURE_GATE_THRESHOLD);
    expect(decision.refuseStart).toBe(false);
  });

  it('six failures in the window refuse the start, and the message names the counter', () => {
    const { rawEnv, counterPath } = sandbox();
    const now = new Date('2026-11-25T12:00:00.000Z');
    const failures = Array.from({ length: BOOT_FAILURE_GATE_THRESHOLD + 1 }, (_, index) =>
      new Date(now.getTime() - index * 1000).toISOString(),
    );
    writeFailures(counterPath, failures);

    const decision = evaluateBootFailureGate(rawEnv, now);
    expect(decision.refuseStart).toBe(true);
    expect(decision.failuresInWindow).toBe(BOOT_FAILURE_GATE_THRESHOLD + 1);

    const message = describeBootFailureGate(decision);
    expect(message).toContain(counterPath);
    expect(message).toContain('crash-looping');
  });

  it('failures that fell out of the window do not count', () => {
    const { rawEnv, counterPath } = sandbox();
    const now = new Date('2026-11-25T12:00:00.000Z');
    const old = new Date(now.getTime() - BOOT_FAILURE_GATE_WINDOW_MS - 60_000).toISOString();
    writeFailures(
      counterPath,
      Array.from({ length: BOOT_FAILURE_GATE_THRESHOLD + 5 }, () => old),
    );

    const decision = evaluateBootFailureGate(rawEnv, now);
    expect(decision.failuresInWindow).toBe(0);
    expect(decision.refuseStart).toBe(false);
  });

  it('a counter that cannot be read is not evidence of a crash loop', () => {
    const { rawEnv, counterPath } = sandbox();
    mkdirSync(dirname(counterPath), { recursive: true });
    writeFileSync(counterPath, '{ this is not json', 'utf8');

    const decision = evaluateBootFailureGate(rawEnv);
    expect(decision.failuresInWindow).toBe(0);
    expect(decision.refuseStart).toBe(false);
  });

  it('the gate reads the counter the runtime writes', () => {
    const { rawEnv } = sandbox();
    for (let attempt = 0; attempt < BOOT_FAILURE_GATE_THRESHOLD + 1; attempt += 1) {
      recordBootAttempt(rawEnv);
    }

    const decision = evaluateBootFailureGate(rawEnv);
    expect(decision.failuresInWindow).toBe(BOOT_FAILURE_GATE_THRESHOLD + 1);
    expect(decision.refuseStart).toBe(true);
  });
});
