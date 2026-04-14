import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  __resetSelfModifyRevertForTests,
  evaluateAutoRevert,
  performAutoRevert,
  recordBootAttempt,
  recordBootSuccess,
  recordSelfModifyCommit,
} from '../../src/infra/runtime/self-modify-revert.js';

describe('self-modify boot-failure auto-revert (Phase 2.3)', () => {
  let dataDir: string;
  let env: NodeJS.ProcessEnv;

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), 'memphis-self-modify-revert-'));
    env = { MEMPHIS_DATA_DIR: dataDir } as NodeJS.ProcessEnv;
  });

  afterEach(() => {
    __resetSelfModifyRevertForTests(env);
    rmSync(dataDir, { recursive: true, force: true });
  });

  it('no marker → no revert', () => {
    recordBootAttempt(env);
    const decision = evaluateAutoRevert(env);
    expect(decision.shouldRevert).toBe(false);
    expect(decision.reason).toBe('no-marker');
  });

  it('marker but no boot failures → no revert', () => {
    recordSelfModifyCommit(
      { commitHash: 'abc', previousHash: 'def', intent: 'test' },
      env,
    );
    const decision = evaluateAutoRevert(env);
    expect(decision.shouldRevert).toBe(false);
    expect(decision.reason).toBe('no-failures');
  });

  it('boot failures BELOW threshold → no revert', () => {
    recordSelfModifyCommit(
      { commitHash: 'abc', previousHash: 'def', intent: 'test' },
      env,
    );
    recordBootAttempt(env); // 1
    recordBootAttempt(env); // 2
    const decision = evaluateAutoRevert({
      ...env,
      MEMPHIS_SELF_MODIFY_REVERT_AFTER_BOOT_FAILURES: '5',
    } as NodeJS.ProcessEnv);
    expect(decision.shouldRevert).toBe(false);
    expect(decision.reason).toBe('failures-below-threshold');
    expect(decision.failuresInWindow).toBe(2);
  });

  it('boot failures AT threshold + marker recent → revert', () => {
    recordSelfModifyCommit(
      { commitHash: 'abc', previousHash: 'def', intent: 'test' },
      env,
    );
    recordBootAttempt(env);
    recordBootAttempt(env);
    recordBootAttempt(env);
    const decision = evaluateAutoRevert({
      ...env,
      MEMPHIS_SELF_MODIFY_REVERT_AFTER_BOOT_FAILURES: '3',
    } as NodeJS.ProcessEnv);
    expect(decision.shouldRevert).toBe(true);
    expect(decision.reason).toBe('will-revert');
    expect(decision.marker?.previousHash).toBe('def');
  });

  it('marker too old (committed before window started) → no revert', () => {
    // Hand-write an OLD marker file directly so we don't depend on
    // recordSelfModifyCommit's now() behavior.
    const markerFile = join(dataDir, 'state', 'last-self-modify.json');
    mkdirSync(dirname(markerFile), { recursive: true });
    writeFileSync(
      markerFile,
      JSON.stringify({
        commitHash: 'abc',
        previousHash: 'def',
        intent: 'old',
        committedAt: new Date(Date.now() - 60 * 60 * 1000).toISOString(), // 1h ago
      }),
      'utf8',
    );
    // Recent boot failures (within window)
    recordBootAttempt(env);
    recordBootAttempt(env);
    recordBootAttempt(env);
    const decision = evaluateAutoRevert({
      ...env,
      MEMPHIS_SELF_MODIFY_REVERT_AFTER_BOOT_FAILURES: '3',
      MEMPHIS_SELF_MODIFY_REVERT_WINDOW_MS: '60000', // 1 min
    } as NodeJS.ProcessEnv);
    expect(decision.shouldRevert).toBe(false);
    expect(decision.reason).toBe('marker-too-old');
    expect(decision.failuresInWindow).toBe(3);
  });

  it('MEMPHIS_SELF_MODIFY_AUTO_REVERT=false disables the feature', () => {
    recordSelfModifyCommit(
      { commitHash: 'abc', previousHash: 'def', intent: 'test' },
      env,
    );
    recordBootAttempt(env);
    recordBootAttempt(env);
    recordBootAttempt(env);
    const decision = evaluateAutoRevert({
      ...env,
      MEMPHIS_SELF_MODIFY_REVERT_AFTER_BOOT_FAILURES: '3',
      MEMPHIS_SELF_MODIFY_AUTO_REVERT: 'false',
    } as NodeJS.ProcessEnv);
    expect(decision.shouldRevert).toBe(false);
    expect(decision.reason).toBe('auto-revert-disabled');
  });

  it('recordBootSuccess clears the failure counter', () => {
    recordBootAttempt(env);
    recordBootAttempt(env);
    recordBootSuccess(env);
    const decision = evaluateAutoRevert(env);
    expect(decision.failuresInWindow).toBe(0);
  });

  it('performAutoRevert calls git reset and clears state', async () => {
    recordSelfModifyCommit(
      { commitHash: 'abc', previousHash: 'def', intent: 'test' },
      env,
    );
    recordBootAttempt(env);
    recordBootAttempt(env);
    recordBootAttempt(env);
    const decision = evaluateAutoRevert({
      ...env,
      MEMPHIS_SELF_MODIFY_REVERT_AFTER_BOOT_FAILURES: '3',
    } as NodeJS.ProcessEnv);
    expect(decision.shouldRevert).toBe(true);

    const gitResetFn = vi.fn(async () => {});
    const result = await performAutoRevert(decision, {
      projectRoot: '/tmp/fake',
      rawEnv: env,
      gitResetFn,
    });
    expect(result.ok).toBe(true);
    expect(result.revertedTo).toBe('def');
    expect(gitResetFn).toHaveBeenCalledWith('def', '/tmp/fake');

    // Marker + failure counter cleared so next boot starts fresh
    const followUp = evaluateAutoRevert(env);
    expect(followUp.reason).toBe('no-marker');
    expect(followUp.failuresInWindow).toBe(0);
  });

  it('performAutoRevert reports git failure cleanly', async () => {
    recordSelfModifyCommit(
      { commitHash: 'abc', previousHash: 'def', intent: 'test' },
      env,
    );
    recordBootAttempt(env);
    recordBootAttempt(env);
    recordBootAttempt(env);
    const decision = evaluateAutoRevert({
      ...env,
      MEMPHIS_SELF_MODIFY_REVERT_AFTER_BOOT_FAILURES: '3',
    } as NodeJS.ProcessEnv);
    const result = await performAutoRevert(decision, {
      rawEnv: env,
      gitResetFn: async () => {
        throw new Error('git: bad ref');
      },
    });
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/git: bad ref/);
  });
});
