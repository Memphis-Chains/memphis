import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { WebDashboard, type DashboardData } from '../../src/dashboard/web-dashboard.ts';

/**
 * Regression net for #143. Dashboard /api/data and the HTML dashboard
 * used to be unauthenticated. Default bind is localhost so the default
 * case is safe, but there was no way for an operator to enforce auth
 * when binding non-loopback. This test verifies the optional Bearer
 * token enforcement works end-to-end.
 */

function emptyData(): DashboardData {
  return {
    stats: {
      totalBlocks: 0,
      totalChains: 0,
      oldestBlock: '',
      newestBlock: '',
      topTags: [],
      blocksPerChain: [],
    },
    insights: [],
    predictions: [],
    mood: 'productive',
    quickWins: [],
    nextActions: [],
  };
}

describe('web-dashboard auth token (#143)', () => {
  let dashboard: WebDashboard;
  let port: number;

  beforeEach(async () => {
    dashboard = new WebDashboard(async () => emptyData(), {
      port: 0,
      host: '127.0.0.1',
      authToken: 's3cret-token',
    });
    await dashboard.start();
    // Pull the assigned port from the internal server.
    const server = (dashboard as unknown as { server: { address: () => { port: number } } }).server;
    port = server.address().port;
  });

  afterEach(async () => {
    await dashboard.stop();
  });

  it('/api/data with no Authorization returns 401', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/api/data`);
    expect(res.status).toBe(401);
  });

  it('/api/data with wrong Bearer token returns 401', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/api/data`, {
      headers: { Authorization: 'Bearer nope' },
    });
    expect(res.status).toBe(401);
  });

  it('/api/data with correct Bearer token returns 200 + JSON', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/api/data`, {
      headers: { Authorization: 'Bearer s3cret-token' },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as DashboardData;
    expect(body.stats.totalBlocks).toBe(0);
  });

  it('/ (HTML dashboard) also requires the token', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/`);
    expect(res.status).toBe(401);

    const authed = await fetch(`http://127.0.0.1:${port}/`, {
      headers: { Authorization: 'Bearer s3cret-token' },
    });
    expect(authed.status).toBe(200);
    expect(authed.headers.get('content-type') ?? '').toMatch(/text\/html/);
  });

  it('/api/health stays public (for monitoring)', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/api/health`);
    expect(res.status).toBe(200);
  });
});

describe('web-dashboard default (no auth) backward-compat', () => {
  let dashboard: WebDashboard;
  let port: number;

  beforeEach(async () => {
    dashboard = new WebDashboard(async () => emptyData(), {
      port: 0,
      host: '127.0.0.1',
      // authToken: undefined — default path, no auth required
    });
    await dashboard.start();
    const server = (dashboard as unknown as { server: { address: () => { port: number } } }).server;
    port = server.address().port;
  });

  afterEach(async () => {
    await dashboard.stop();
  });

  it('/api/data is accessible without auth when no token configured', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/api/data`);
    expect(res.status).toBe(200);
  });
});
