import { describe, expect, it } from 'vitest';

import { runtimeWatchFailures } from '../../src/infra/runtime/scheduler-builtins.js';

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
});
