import { describe, expect, it } from 'vitest';

import {
  describeHealthFailure,
  runtimeWatchFailures,
} from '../../src/infra/runtime/scheduler-builtins.js';

describe('runtime watch decision', () => {
  // The alert used to fire on the 7-day SLO, so ONE failed turn in a week
  // kept it firing every six hours until the window rolled over — a week
  // of "something failed" mail for a system that was healthy the moment
  // the failure passed. Measured on this host: the only provider error in
  // the window was from 2026-10-25 16:48 (the workspace ran out of
  // credits and recovered), and it kept the alert armed for six days.
  it('does not fail while the last attempt succeeded', () => {
    const failures = runtimeWatchFailures({
      healthStatus: 'healthy',
      recent: {
        turn: { ts: '2026-10-26T10:00:00Z', status: 'ok' },
        provider: { ts: '2026-10-26T10:00:00Z', status: 'ok' },
        tool: null,
      },
      failingSlos: ['provider_error_rate', 'p99_turn_latency_ms'],
    });
    expect(failures).toEqual([]);
  });

  it('fails when the last turn failed', () => {
    const failures = runtimeWatchFailures({
      healthStatus: 'healthy',
      recent: {
        turn: { ts: '2026-10-26T10:00:00Z', status: 'error' },
        provider: { ts: '2026-10-26T10:00:00Z', status: 'ok' },
        tool: null,
      },
      failingSlos: [],
    });
    expect(failures).toContain('last turn failed');
  });

  it('fails when the last provider call failed', () => {
    const failures = runtimeWatchFailures({
      healthStatus: 'healthy',
      recent: {
        turn: { ts: '2026-10-26T10:00:00Z', status: 'ok' },
        provider: { ts: '2026-10-26T10:00:00Z', status: 'error' },
        tool: null,
      },
      failingSlos: [],
    });
    expect(failures).toContain('last provider call failed');
  });

  it('fails when the health check is not healthy', () => {
    const failures = runtimeWatchFailures({
      healthStatus: 'degraded',
      recent: { turn: null, provider: null, tool: null },
      failingSlos: [],
    });
    expect(failures).toEqual(['health=degraded']);
  });

  it('fails when nothing has run yet but the window reports failures', () => {
    // No recent activity means no evidence either way. A failing SLO over a
    // window that contains no attempts at all is not a broken system, it is
    // a window with nothing in it.
    const failures = runtimeWatchFailures({
      healthStatus: 'healthy',
      recent: { turn: null, provider: null, tool: null },
      failingSlos: ['provider_error_rate'],
    });
    expect(failures).toEqual([]);
  });

  // Measured 2026-10-29: the watch alerted `health=unhealthy` and the
  // message named nothing but the status. An alert that does not say
  // what broke is not a diagnosis.
  it('names the unhealthy part in the alert message', () => {
    const failures = runtimeWatchFailures({
      healthStatus: 'unhealthy',
      healthDetail: 'repair=degraded-repairable: exact-search derived state needs repair',
      recent: { turn: null, provider: null, tool: null },
      failingSlos: [],
    });
    expect(failures).toEqual([
      'health=unhealthy (repair=degraded-repairable: exact-search derived state needs repair)',
    ]);
  });

  it('keeps the bare status when there is no detail to give', () => {
    const failures = runtimeWatchFailures({
      healthStatus: 'unhealthy',
      recent: { turn: null, provider: null, tool: null },
      failingSlos: [],
    });
    expect(failures).toEqual(['health=unhealthy']);
  });
});

describe('describeHealthFailure', () => {
  it('names the repair state and its first reason', () => {
    const detail = describeHealthFailure({
      runtime: {
        repair: {
          status: 'degraded-repairable',
          reasons: ['exact-search derived state needs repair'],
        },
      },
    });
    expect(detail).toBe('repair=degraded-repairable: exact-search derived state needs repair');
  });

  it('falls back to a failing check when the repair state is healthy', () => {
    const detail = describeHealthFailure({
      runtime: { repair: { status: 'healthy', reasons: [] } },
      checks: {
        database: { status: 'fail', message: 'database file is not writable' },
      },
    });
    expect(detail).toBe('check=database=fail: database file is not writable');
  });

  it('returns nothing for a healthy payload', () => {
    const detail = describeHealthFailure({
      runtime: { repair: { status: 'healthy', reasons: [] } },
      checks: { database: { status: 'ok' } },
    });
    expect(detail).toBeUndefined();
  });
});
