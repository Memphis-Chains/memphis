import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  __resetCostCapForTests,
  checkProviderBudget,
  consumeSoftWarning,
  getAllProviderBudgets,
  queryProviderBudget,
  recordProviderUsage,
} from '../../src/infra/runtime/cost-cap.js';

describe('cost cap & budget observability (Phase 1.3)', () => {
  beforeEach(() => {
    __resetCostCapForTests();
  });

  afterEach(() => {
    __resetCostCapForTests();
  });

  it('no cap configured → allowed=true, reason=no-cap-configured', () => {
    const decision = queryProviderBudget('anthropic', {} as NodeJS.ProcessEnv);
    expect(decision.allowed).toBe(true);
    expect(decision.reason).toBe('no-cap-configured');
    expect(decision.daily.cap).toBeUndefined();
    expect(decision.monthly.cap).toBeUndefined();
  });

  it('records usage; daily and monthly counters increment', () => {
    const env = {
      MEMPHIS_COST_CAP_ANTHROPIC_DAILY_TOKENS: '10000',
    } as NodeJS.ProcessEnv;
    recordProviderUsage('anthropic', 100, 200, env);
    recordProviderUsage('anthropic', 50, 75, env);
    const d = queryProviderBudget('anthropic', env);
    expect(d.daily.used).toBe(425);
    expect(d.monthly.used).toBe(425);
    expect(d.daily.cap).toBe(10000);
  });

  it('within budget → reason=within-budget below 50%', () => {
    const env = {
      MEMPHIS_COST_CAP_ANTHROPIC_DAILY_TOKENS: '10000',
    } as NodeJS.ProcessEnv;
    recordProviderUsage('anthropic', 1000, 1000, env);
    const d = queryProviderBudget('anthropic', env);
    expect(d.reason).toBe('within-budget');
  });

  it('soft-warning thresholds at 50/75/90%', () => {
    const env = {
      MEMPHIS_COST_CAP_ANTHROPIC_DAILY_TOKENS: '1000',
    } as NodeJS.ProcessEnv;
    recordProviderUsage('anthropic', 250, 250, env); // 50%
    expect(queryProviderBudget('anthropic', env).reason).toBe('soft-warning-50');
    recordProviderUsage('anthropic', 250, 0, env); // 75%
    expect(queryProviderBudget('anthropic', env).reason).toBe('soft-warning-75');
    recordProviderUsage('anthropic', 150, 0, env); // 90%
    expect(queryProviderBudget('anthropic', env).reason).toBe('soft-warning-90');
  });

  it('hard cap → checkProviderBudget throws PROVIDER_RATE_LIMIT', () => {
    const env = {
      MEMPHIS_COST_CAP_ANTHROPIC_DAILY_TOKENS: '500',
    } as NodeJS.ProcessEnv;
    recordProviderUsage('anthropic', 600, 0, env);
    expect(() => checkProviderBudget('anthropic', env)).toThrow(/budget cap exceeded/);
  });

  it('cap-exceeded message names both daily and monthly status', () => {
    const env = {
      MEMPHIS_COST_CAP_ANTHROPIC_DAILY_TOKENS: '500',
      MEMPHIS_COST_CAP_ANTHROPIC_MONTHLY_TOKENS: '5000',
    } as NodeJS.ProcessEnv;
    recordProviderUsage('anthropic', 600, 0, env);
    try {
      checkProviderBudget('anthropic', env);
    } catch (err) {
      expect((err as Error).message).toMatch(/600\/500/);
      expect((err as Error).message).toMatch(/5000/);
    }
  });

  it('consumeSoftWarning fires once per threshold crossing', () => {
    const env = {
      MEMPHIS_COST_CAP_ANTHROPIC_DAILY_TOKENS: '1000',
    } as NodeJS.ProcessEnv;
    recordProviderUsage('anthropic', 500, 0, env); // crosses 50
    expect(consumeSoftWarning('anthropic', env)).toBe(50);
    // Second call without further usage → no new threshold
    expect(consumeSoftWarning('anthropic', env)).toBe(null);
    recordProviderUsage('anthropic', 250, 0, env); // crosses 75
    expect(consumeSoftWarning('anthropic', env)).toBe(75);
    recordProviderUsage('anthropic', 150, 0, env); // crosses 90
    expect(consumeSoftWarning('anthropic', env)).toBe(90);
  });

  it('day rollover resets daily counter (monthly persists)', () => {
    const env = {
      MEMPHIS_COST_CAP_ANTHROPIC_DAILY_TOKENS: '1000',
      MEMPHIS_COST_CAP_ANTHROPIC_MONTHLY_TOKENS: '50000',
    } as NodeJS.ProcessEnv;
    const day1 = new Date('2026-04-14T12:00:00Z');
    recordProviderUsage('anthropic', 800, 0, env, day1);
    const day2 = new Date('2026-04-15T12:00:00Z');
    const d = queryProviderBudget('anthropic', env, day2);
    expect(d.daily.used).toBe(0);
    expect(d.monthly.used).toBe(800);
  });

  it('month rollover resets both', () => {
    const env = {
      MEMPHIS_COST_CAP_ANTHROPIC_MONTHLY_TOKENS: '5000',
    } as NodeJS.ProcessEnv;
    const apr = new Date('2026-04-30T23:00:00Z');
    recordProviderUsage('anthropic', 4000, 0, env, apr);
    const may = new Date('2026-05-01T01:00:00Z');
    const d = queryProviderBudget('anthropic', env, may);
    expect(d.monthly.used).toBe(0);
    expect(d.daily.used).toBe(0);
  });

  it('per-provider counters are independent', () => {
    const env = {
      MEMPHIS_COST_CAP_ANTHROPIC_DAILY_TOKENS: '1000',
      MEMPHIS_COST_CAP_MINIMAX_DAILY_TOKENS: '2000',
    } as NodeJS.ProcessEnv;
    recordProviderUsage('anthropic', 500, 0, env);
    recordProviderUsage('minimax', 1500, 0, env);
    expect(queryProviderBudget('anthropic', env).daily.used).toBe(500);
    expect(queryProviderBudget('minimax', env).daily.used).toBe(1500);
    expect(queryProviderBudget('minimax', env).reason).toBe('soft-warning-75');
  });

  it('getAllProviderBudgets returns one entry per provider with usage', () => {
    const env = {
      MEMPHIS_COST_CAP_ANTHROPIC_DAILY_TOKENS: '1000',
      MEMPHIS_COST_CAP_MINIMAX_DAILY_TOKENS: '2000',
    } as NodeJS.ProcessEnv;
    recordProviderUsage('anthropic', 100, 0, env);
    recordProviderUsage('minimax', 200, 0, env);
    const all = getAllProviderBudgets(env);
    expect(all).toHaveLength(2);
    expect(all.map((b) => b.provider).sort()).toEqual(['anthropic', 'minimax']);
  });

  it('cap raise at runtime (env mid-day) takes effect immediately', () => {
    const tightEnv = {
      MEMPHIS_COST_CAP_ANTHROPIC_DAILY_TOKENS: '500',
    } as NodeJS.ProcessEnv;
    recordProviderUsage('anthropic', 600, 0, tightEnv);
    expect(() => checkProviderBudget('anthropic', tightEnv)).toThrow();
    // Operator raises the cap
    const looserEnv = {
      MEMPHIS_COST_CAP_ANTHROPIC_DAILY_TOKENS: '5000',
    } as NodeJS.ProcessEnv;
    expect(() => checkProviderBudget('anthropic', looserEnv)).not.toThrow();
  });
});
