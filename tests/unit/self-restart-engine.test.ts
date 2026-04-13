import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  __resetTurnControllersForTests,
  registerTurnController,
  requestRestart,
  unregisterTurnController,
} from '../../src/infra/runtime/self-restart.js';
import {
  __resetTier3SessionsForTests,
  __seedTier3SessionForTests,
} from '../../src/security/tier3-session.js';

const ACTOR = 'cli';

const savedEnv = { ...process.env };

beforeEach(() => {
  __resetTier3SessionsForTests();
  __resetTurnControllersForTests();
  for (const key of Object.keys(process.env)) {
    if (!(key in savedEnv)) delete process.env[key];
  }
  Object.assign(process.env, savedEnv);
});

afterEach(() => {
  __resetTier3SessionsForTests();
  __resetTurnControllersForTests();
});

function elevate(): void {
  __seedTier3SessionForTests('cli', ACTOR);
}

describe('requestRestart — refusal paths', () => {
  it('refuses when caller has no tier-3 session', async () => {
    const audits: unknown[] = [];
    const exitFn = vi.fn();
    const outcome = await requestRestart({
      surface: 'cli',
      actorId: ACTOR,
      auditFn: (entry) => {
        audits.push(entry);
      },
      pulseFn: () => {},
      exitFn: exitFn as unknown as (code: number) => never,
    });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.reason).toBe('not-elevated');
    expect((audits[0] as { status: string }).status).toBe('blocked');
    expect(exitFn).not.toHaveBeenCalled();
  });

  it('refuses when no supervisor and MEMPHIS_RESTART_ALLOW_SUICIDE not set', async () => {
    elevate();
    const audits: Array<{ status: string }> = [];
    const exitFn = vi.fn();
    const outcome = await requestRestart({
      surface: 'cli',
      actorId: ACTOR,
      rawEnv: {} as NodeJS.ProcessEnv,
      auditFn: (entry) => audits.push(entry as { status: string }),
      pulseFn: () => {},
      exitFn: exitFn as unknown as (code: number) => never,
    });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.reason).toBe('no-supervisor');
    expect(audits[0]?.status).toBe('blocked');
    expect(exitFn).not.toHaveBeenCalled();
  });
});

describe('requestRestart — happy path', () => {
  it('with a supervisor and tier-3 session: audits, drains, exits', async () => {
    elevate();
    const audits: Array<{ status: string; details?: Record<string, unknown> }> = [];
    const pulses: unknown[] = [];
    const exitFn = vi.fn();
    const outcome = await requestRestart({
      surface: 'cli',
      actorId: ACTOR,
      reason: 'test',
      drainTimeoutMs: 100,
      rawEnv: { NOTIFY_SOCKET: '/run/systemd/notify' } as NodeJS.ProcessEnv,
      auditFn: (entry) => audits.push(entry as { status: string }),
      pulseFn: (entry) => {
        pulses.push(entry);
      },
      exitFn: exitFn as unknown as (code: number) => never,
    });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.supervisor.kind).toBe('systemd');
    expect(outcome.drainTimeoutMs).toBe(100);
    expect(audits[0]?.status).toBe('allowed');
    expect(audits[0]?.details?.supervisor).toBe('systemd');
    expect(pulses).toHaveLength(1);
    // exitFn fires on next tick — wait for it
    await new Promise((resolve) => setImmediate(resolve));
    expect(exitFn).toHaveBeenCalledWith(0);
  });

  it('MEMPHIS_RESTART_ALLOW_SUICIDE=true permits exit without supervisor', async () => {
    elevate();
    const exitFn = vi.fn();
    const outcome = await requestRestart({
      surface: 'cli',
      actorId: ACTOR,
      drainTimeoutMs: 50,
      rawEnv: { MEMPHIS_RESTART_ALLOW_SUICIDE: 'true' } as NodeJS.ProcessEnv,
      auditFn: () => {},
      pulseFn: () => {},
      exitFn: exitFn as unknown as (code: number) => never,
    });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.supervisor.kind).toBeNull();
    await new Promise((resolve) => setImmediate(resolve));
    expect(exitFn).toHaveBeenCalledWith(0);
  });

  it('signals registered turn controllers to abort on drain', async () => {
    elevate();
    const ctrl1 = new AbortController();
    const ctrl2 = new AbortController();
    registerTurnController(ctrl1);
    registerTurnController(ctrl2);
    const aborts: number[] = [];
    ctrl1.signal.addEventListener('abort', () => aborts.push(1));
    ctrl2.signal.addEventListener('abort', () => aborts.push(2));

    const outcome = await requestRestart({
      surface: 'cli',
      actorId: ACTOR,
      drainTimeoutMs: 200,
      rawEnv: { NOTIFY_SOCKET: '/run/systemd/notify' } as NodeJS.ProcessEnv,
      auditFn: () => {},
      pulseFn: () => {},
      exitFn: vi.fn() as unknown as (code: number) => never,
    });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.drainedTurnCount).toBe(2);
    expect(aborts.sort()).toEqual([1, 2]);
    unregisterTurnController(ctrl1);
    unregisterTurnController(ctrl2);
  });
});

describe('drain timeout config', () => {
  it('honors MEMPHIS_RESTART_DRAIN_TIMEOUT_MS env value', async () => {
    elevate();
    const outcome = await requestRestart({
      surface: 'cli',
      actorId: ACTOR,
      rawEnv: {
        NOTIFY_SOCKET: '/run/systemd/notify',
        MEMPHIS_RESTART_DRAIN_TIMEOUT_MS: '750',
      } as NodeJS.ProcessEnv,
      auditFn: () => {},
      pulseFn: () => {},
      exitFn: vi.fn() as unknown as (code: number) => never,
    });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.drainTimeoutMs).toBe(750);
  });
});
