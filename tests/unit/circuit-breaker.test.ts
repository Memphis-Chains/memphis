import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  __resetBreakersForTests,
  admitProviderCall,
  DEFAULT_COOLDOWN_MS,
  DEFAULT_FAILURE_THRESHOLD,
  DEFAULT_WINDOW_MS,
  getAllBreakerSnapshots,
  getBreakerSnapshot,
  recordProviderOutcome,
} from '../../src/infra/runtime/circuit-breaker.js';

describe('circuit breaker (Phase 2.1 production sprint)', () => {
  beforeEach(() => {
    __resetBreakersForTests();
  });

  afterEach(() => {
    __resetBreakersForTests();
  });

  it('starts CLOSED and admits without throwing', () => {
    expect(() => admitProviderCall('anthropic', {} as NodeJS.ProcessEnv)).not.toThrow();
    const snap = getBreakerSnapshot('anthropic', {} as NodeJS.ProcessEnv);
    expect(snap.state).toBe('closed');
    expect(snap.failureThreshold).toBe(DEFAULT_FAILURE_THRESHOLD);
    expect(snap.windowMs).toBe(DEFAULT_WINDOW_MS);
    expect(snap.cooldownMs).toBe(DEFAULT_COOLDOWN_MS);
  });

  it('trips OPEN after failureThreshold failures within window', () => {
    const env = { MEMPHIS_BREAKER_DEFAULT_FAILURES: '3' } as NodeJS.ProcessEnv;
    for (let i = 0; i < 3; i += 1) {
      recordProviderOutcome('anthropic', false, env, 1000 + i);
    }
    const snap = getBreakerSnapshot('anthropic', env);
    expect(snap.state).toBe('open');
    expect(snap.totalTrips).toBe(1);
  });

  it('OPEN admit fails fast with PROVIDER_RATE_LIMIT', () => {
    const env = { MEMPHIS_BREAKER_DEFAULT_FAILURES: '2' } as NodeJS.ProcessEnv;
    recordProviderOutcome('anthropic', false, env, 1000);
    recordProviderOutcome('anthropic', false, env, 2000);
    expect(() => admitProviderCall('anthropic', env, 3000)).toThrow(/circuit breaker is OPEN/);
  });

  it('OPEN → HALF_OPEN after cooldown elapses; admits one probe', () => {
    const env = {
      MEMPHIS_BREAKER_DEFAULT_FAILURES: '2',
      MEMPHIS_BREAKER_DEFAULT_COOLDOWN_MS: '5000',
    } as NodeJS.ProcessEnv;
    recordProviderOutcome('anthropic', false, env, 1000);
    recordProviderOutcome('anthropic', false, env, 2000);
    expect(getBreakerSnapshot('anthropic', env).state).toBe('open');
    // Before cooldown — fails fast
    expect(() => admitProviderCall('anthropic', env, 3000)).toThrow();
    // After cooldown — admits probe and transitions to half-open
    expect(() => admitProviderCall('anthropic', env, 8000)).not.toThrow();
    expect(getBreakerSnapshot('anthropic', env).state).toBe('half-open');
  });

  it('HALF_OPEN admits ONE probe; subsequent calls fail fast', () => {
    const env = {
      MEMPHIS_BREAKER_DEFAULT_FAILURES: '2',
      MEMPHIS_BREAKER_DEFAULT_COOLDOWN_MS: '5000',
    } as NodeJS.ProcessEnv;
    recordProviderOutcome('anthropic', false, env, 1000);
    recordProviderOutcome('anthropic', false, env, 2000);
    admitProviderCall('anthropic', env, 8000); // probe in flight
    expect(() => admitProviderCall('anthropic', env, 8001)).toThrow(/HALF-OPEN.*probe in flight/);
  });

  it('HALF_OPEN probe success → CLOSED + recovery counted', () => {
    const env = {
      MEMPHIS_BREAKER_DEFAULT_FAILURES: '2',
      MEMPHIS_BREAKER_DEFAULT_COOLDOWN_MS: '5000',
    } as NodeJS.ProcessEnv;
    recordProviderOutcome('anthropic', false, env, 1000);
    recordProviderOutcome('anthropic', false, env, 2000);
    admitProviderCall('anthropic', env, 8000);
    recordProviderOutcome('anthropic', true, env, 8500);
    const snap = getBreakerSnapshot('anthropic', env);
    expect(snap.state).toBe('closed');
    expect(snap.totalRecoveries).toBe(1);
    expect(snap.recentFailures).toBe(0);
  });

  it('HALF_OPEN probe failure → re-OPEN with fresh cooldown', () => {
    const env = {
      MEMPHIS_BREAKER_DEFAULT_FAILURES: '2',
      MEMPHIS_BREAKER_DEFAULT_COOLDOWN_MS: '5000',
    } as NodeJS.ProcessEnv;
    recordProviderOutcome('anthropic', false, env, 1000);
    recordProviderOutcome('anthropic', false, env, 2000);
    admitProviderCall('anthropic', env, 8000);
    recordProviderOutcome('anthropic', false, env, 8500);
    const snap = getBreakerSnapshot('anthropic', env);
    expect(snap.state).toBe('open');
    expect(snap.totalTrips).toBe(2);
  });

  it('failures outside the rolling window are forgotten', () => {
    const env = {
      MEMPHIS_BREAKER_DEFAULT_FAILURES: '3',
      MEMPHIS_BREAKER_DEFAULT_WINDOW_MS: '1000',
    } as NodeJS.ProcessEnv;
    recordProviderOutcome('anthropic', false, env, 1000);
    recordProviderOutcome('anthropic', false, env, 1500);
    // Big gap — old failures fall off when next ones land
    recordProviderOutcome('anthropic', false, env, 5000);
    recordProviderOutcome('anthropic', false, env, 5100);
    const snap = getBreakerSnapshot('anthropic', env);
    expect(snap.state).toBe('closed');
    expect(snap.recentFailures).toBe(2);
  });

  it('per-provider override beats default', () => {
    const env = {
      MEMPHIS_BREAKER_DEFAULT_FAILURES: '5',
      MEMPHIS_BREAKER_ANTHROPIC_FAILURES: '2',
    } as NodeJS.ProcessEnv;
    recordProviderOutcome('anthropic', false, env, 1000);
    recordProviderOutcome('anthropic', false, env, 2000);
    expect(getBreakerSnapshot('anthropic', env).state).toBe('open');
    // minimax keeps the default
    recordProviderOutcome('minimax', false, env, 1000);
    recordProviderOutcome('minimax', false, env, 2000);
    expect(getBreakerSnapshot('minimax', env).state).toBe('closed');
  });

  it('getAllBreakerSnapshots returns one entry per touched provider', () => {
    recordProviderOutcome('anthropic', true, {} as NodeJS.ProcessEnv);
    recordProviderOutcome('minimax', false, {} as NodeJS.ProcessEnv);
    const all = getAllBreakerSnapshots({} as NodeJS.ProcessEnv);
    expect(all).toHaveLength(2);
  });
});
