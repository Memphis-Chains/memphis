/**
 * REV2 Temat 3.5 Warstwa 5 — exec failure budget.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  describeBudgetRefusal,
  getConsecutiveFailures,
  isExecBlockedForBudget,
  MAX_CONSECUTIVE_FAILURES,
  recordExecOutcome,
  resetAllExecBudgetsForTests,
  resetOnNonExecToolCall,
} from '../../src/gateway/exec-failure-budget.js';

const KEY = { surface: 'telegram', actorId: 'chat-42' };

describe('exec failure budget', () => {
  beforeEach(() => {
    resetAllExecBudgetsForTests();
  });

  afterEach(() => {
    resetAllExecBudgetsForTests();
  });

  it('starts at 0 failures, not blocked', () => {
    expect(getConsecutiveFailures(KEY)).toBe(0);
    expect(isExecBlockedForBudget(KEY)).toBe(false);
  });

  it('non-zero exit increments the counter', () => {
    recordExecOutcome(KEY, 1);
    expect(getConsecutiveFailures(KEY)).toBe(1);
    recordExecOutcome(KEY, 127);
    expect(getConsecutiveFailures(KEY)).toBe(2);
    expect(isExecBlockedForBudget(KEY)).toBe(false);
  });

  it(`blocks after ${MAX_CONSECUTIVE_FAILURES} consecutive failures`, () => {
    for (let i = 0; i < MAX_CONSECUTIVE_FAILURES; i += 1) {
      recordExecOutcome(KEY, 1);
    }
    expect(getConsecutiveFailures(KEY)).toBe(MAX_CONSECUTIVE_FAILURES);
    expect(isExecBlockedForBudget(KEY)).toBe(true);
  });

  it('successful exec decrements (clamped at 0)', () => {
    recordExecOutcome(KEY, 1);
    recordExecOutcome(KEY, 1);
    expect(getConsecutiveFailures(KEY)).toBe(2);
    recordExecOutcome(KEY, 0);
    expect(getConsecutiveFailures(KEY)).toBe(1);
    recordExecOutcome(KEY, 0);
    recordExecOutcome(KEY, 0);
    expect(getConsecutiveFailures(KEY)).toBe(0);
  });

  it('resetOnNonExecToolCall clears the bucket entirely', () => {
    recordExecOutcome(KEY, 1);
    recordExecOutcome(KEY, 1);
    recordExecOutcome(KEY, 1);
    expect(isExecBlockedForBudget(KEY)).toBe(true);
    resetOnNonExecToolCall(KEY);
    expect(getConsecutiveFailures(KEY)).toBe(0);
    expect(isExecBlockedForBudget(KEY)).toBe(false);
  });

  it('tracks (surface, actor) independently', () => {
    const a = { surface: 'telegram', actorId: 'chat-1' };
    const b = { surface: 'telegram', actorId: 'chat-2' };
    recordExecOutcome(a, 1);
    recordExecOutcome(a, 1);
    recordExecOutcome(a, 1);
    expect(isExecBlockedForBudget(a)).toBe(true);
    expect(isExecBlockedForBudget(b)).toBe(false);
  });

  it('refusal message names the counter + remediation', () => {
    recordExecOutcome(KEY, 1);
    recordExecOutcome(KEY, 1);
    recordExecOutcome(KEY, 1);
    const msg = describeBudgetRefusal(KEY);
    expect(msg).toContain('3');
    expect(msg).toContain('blind-retry');
    expect(msg).toContain('memphis_exec_analyze');
  });
});
