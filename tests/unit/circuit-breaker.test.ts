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

  it('Codex Round 6 P1: failures after breaker is already OPEN do NOT reset cooldown', () => {
    // Trip the breaker
    const env = {
      MEMPHIS_BREAKER_DEFAULT_FAILURES: '2',
      MEMPHIS_BREAKER_DEFAULT_COOLDOWN_MS: '5000',
    } as NodeJS.ProcessEnv;
    recordProviderOutcome('anthropic', false, env, 1000);
    recordProviderOutcome('anthropic', false, env, 2000);
    const openedAt = getBreakerSnapshot('anthropic', env).openedAt;
    const trips = getBreakerSnapshot('anthropic', env).totalTrips;
    expect(trips).toBe(1);

    // More failures land AFTER state flipped (stale concurrent requests)
    // — cooldown must NOT be extended and totalTrips must stay at 1.
    recordProviderOutcome('anthropic', false, env, 3000);
    recordProviderOutcome('anthropic', false, env, 4000);
    const snap = getBreakerSnapshot('anthropic', env);
    expect(snap.state).toBe('open');
    expect(snap.openedAt).toBe(openedAt);
    expect(snap.totalTrips).toBe(1);
  });

  // Codex P1 follow-up on PR #141. Prior revision of turn-runtime.ts
  // skipped recordProviderOutcome entirely on non-transient errors.
  // admitProviderCall had already set halfOpenProbeInFlight=true, so
  // the next call saw "probe in flight" and failed fast forever.
  it('non-transient failure during half-open probe clears the probe flag (no stranded probe)', () => {
    const env = {
      MEMPHIS_BREAKER_DEFAULT_FAILURES: '2',
      MEMPHIS_BREAKER_DEFAULT_COOLDOWN_MS: '1000',
    } as NodeJS.ProcessEnv;

    // Trip the breaker open
    recordProviderOutcome('anthropic', false, env, 1000);
    recordProviderOutcome('anthropic', false, env, 1100);
    expect(getBreakerSnapshot('anthropic', env).state).toBe('open');

    // Wait past cooldown, admit the probe → halfOpenProbeInFlight=true
    admitProviderCall('anthropic', env, 3000);
    expect(getBreakerSnapshot('anthropic', env).state).toBe('half-open');
    expect(getBreakerSnapshot('anthropic', env).halfOpenProbeInFlight).toBe(true);

    // Non-transient failure: countAsTrip=false — probe flag MUST clear,
    // state stays half-open (don't re-open for validation errors).
    recordProviderOutcome('anthropic', false, env, 3100, { countAsTrip: false });
    const snap = getBreakerSnapshot('anthropic', env);
    expect(snap.halfOpenProbeInFlight).toBe(false);
    expect(snap.state).toBe('half-open'); // still half-open, not re-opened

    // Next call must be admitted (as another probe), not fail fast.
    expect(() => admitProviderCall('anthropic', env, 3200)).not.toThrow();
  });

  it('transient failure during half-open probe re-opens (countAsTrip default)', () => {
    const env = {
      MEMPHIS_BREAKER_DEFAULT_FAILURES: '2',
      MEMPHIS_BREAKER_DEFAULT_COOLDOWN_MS: '1000',
    } as NodeJS.ProcessEnv;
    recordProviderOutcome('anthropic', false, env, 1000);
    recordProviderOutcome('anthropic', false, env, 1100);
    admitProviderCall('anthropic', env, 3000);
    recordProviderOutcome('anthropic', false, env, 3100); // default countAsTrip=true
    const snap = getBreakerSnapshot('anthropic', env);
    expect(snap.state).toBe('open');
    expect(snap.halfOpenProbeInFlight).toBe(false);
  });

  it('non-transient failure in closed state does not count toward trip', () => {
    const env = {
      MEMPHIS_BREAKER_DEFAULT_FAILURES: '2',
    } as NodeJS.ProcessEnv;
    recordProviderOutcome('anthropic', false, env, 1000, { countAsTrip: false });
    recordProviderOutcome('anthropic', false, env, 1100, { countAsTrip: false });
    recordProviderOutcome('anthropic', false, env, 1200, { countAsTrip: false });
    const snap = getBreakerSnapshot('anthropic', env);
    expect(snap.state).toBe('closed');
    expect(snap.totalTrips).toBe(0);
  });
});
