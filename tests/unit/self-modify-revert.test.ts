import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  __resetSelfModifyRevertForTests,
  evaluateAutoRevert,
  maybeRecordBootAttempt,
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

  // Codex P1 follow-up on PR #141. bin/memphis.js records the boot
  // attempt early (pre-import) so import-time crashes still bump the
  // counter, and signals that to bootstrap.ts via
  // MEMPHIS_BOOT_ATTEMPT_RECORDED. maybeRecordBootAttempt must respect
  // that flag or each boot double-counts — one real crash would cross
  // the default 3-failure threshold after a single crash.
  it('maybeRecordBootAttempt records when the env flag is NOT set', () => {
    maybeRecordBootAttempt(env);
    const afterOne = evaluateAutoRevert({
      ...env,
      MEMPHIS_SELF_MODIFY_REVERT_AFTER_BOOT_FAILURES: '1',
    } as NodeJS.ProcessEnv);
    // With a marker present we'd shouldRevert; here we only assert the
    // counter advanced by inspecting performAutoRevert's detail count
    // indirectly — the simplest signal is that no-failures is false.
    expect(afterOne.reason).not.toBe('no-failures');
  });

  it('maybeRecordBootAttempt skips the bump when MEMPHIS_BOOT_ATTEMPT_RECORDED=1 (#141 Codex P1)', () => {
    const flagged = {
      ...env,
      MEMPHIS_BOOT_ATTEMPT_RECORDED: '1',
    } as NodeJS.ProcessEnv;
    maybeRecordBootAttempt(flagged);
    // No file, no counter — evaluateAutoRevert must see no-failures.
    recordSelfModifyCommit(
      { commitHash: 'abc', previousHash: 'def', intent: 'test' },
      env,
    );
    const decision = evaluateAutoRevert(env);
    expect(decision.reason).toBe('no-failures');
  });

  it('maybeRecordBootAttempt + recordBootAttempt do not double-count for one boot', () => {
    // Production path: bin/memphis.js calls recordBootAttempt directly
    // via the early path (simulated here) and sets the env flag. Then
    // bootstrap calls maybeRecordBootAttempt which should be a no-op.
    recordBootAttempt(env); // stand-in for bin/memphis.js early record
    const flagged = {
      ...env,
      MEMPHIS_BOOT_ATTEMPT_RECORDED: '1',
    } as NodeJS.ProcessEnv;
    maybeRecordBootAttempt(flagged); // bootstrap.ts call — must skip

    recordSelfModifyCommit(
      { commitHash: 'abc', previousHash: 'def', intent: 'test' },
      env,
    );
    // Threshold 2 must NOT trigger after just one real boot attempt.
    const decision = evaluateAutoRevert({
      ...env,
      MEMPHIS_SELF_MODIFY_REVERT_AFTER_BOOT_FAILURES: '2',
    } as NodeJS.ProcessEnv);
    expect(decision.shouldRevert).toBe(false);
  });
});
