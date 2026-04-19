/**
 * Tests for federation HTTP routes (src/infra/http/routes/federation.ts).
 * Validates request schemas, response shapes, and error handling.
 */

import { describe, expect, it } from 'vitest';

import { registerFederationRoutes } from '../../src/infra/http/routes/federation.js';

function createMockApp() {
  const routes: Record<string, Record<string, (...args: unknown[]) => unknown>> = {};

  return {
    get: (path: string, handler: (...args: unknown[]) => unknown) => {
      routes[`GET:${path}`] = { handler };
    },
    post: (path: string, handler: (...args: unknown[]) => unknown) => {
      routes[`POST:${path}`] = { handler };
    },
    getHandler: (method: string, path: string) => routes[`${method}:${path}`]?.handler,
    routes,
  };
}

function createMockReply() {
  let statusCode = 200;
  let body: unknown;
  return {
    status(code: number) {
      statusCode = code;
      return this;
    },
    send(data: unknown) {
      body = data;
      return data;
    },
    getStatus: () => statusCode,
    getBody: () => body,
  };
}

describe('federation routes', () => {
  it('registers all expected routes', () => {
    const app = createMockApp();
    registerFederationRoutes(app as never);

    expect(app.getHandler('GET', '/api/federation/health')).toBeDefined();
    expect(app.getHandler('POST', '/api/federation/peers/register')).toBeDefined();
    expect(app.getHandler('POST', '/api/federation/peers/heartbeat')).toBeDefined();
    expect(app.getHandler('GET', '/api/federation/peers')).toBeDefined();
  });

  it('health endpoint returns federation status', async () => {
    const app = createMockApp();
    registerFederationRoutes(app as never, undefined, {
      MEMPHIS_MATRIX_ENABLED: 'true',
      MEMPHIS_MATRIX_HOMESERVER: 'https://matrix.internal.example',
      MEMPHIS_MATRIX_ACCESS_TOKEN: 'matrix-token',
    });

    const handler = app.getHandler('GET', '/api/federation/health')!;
    const reply = createMockReply();
    await handler({}, reply);

    const body = reply.getBody() as Record<string, unknown>;
    expect(body.federation).toBeDefined();
    expect(['ready', 'unavailable']).toContain(body.federation);
    expect(['trusted-pilot', 'public-deferred']).toContain(body.trustMode);
    expect(Array.isArray(body.reasons)).toBe(true);
    expect(body.matrix).toBeDefined();
  });

  it('peers list returns empty when no repo', async () => {
    const app = createMockApp();
    registerFederationRoutes(app as never); // no peerRepo

    const handler = app.getHandler('GET', '/api/federation/peers')!;
    const reply = createMockReply();
    await handler({ query: {} }, reply);

    const body = reply.getBody() as { peers: unknown[]; count: number };
    expect(body.peers).toEqual([]);
    expect(body.count).toBe(0);
  });

  it('register returns 503 when no peer repo', async () => {
    const app = createMockApp();
    registerFederationRoutes(app as never);

    const handler = app.getHandler('POST', '/api/federation/peers/register')!;
    const reply = createMockReply();
    await handler({ body: {} }, reply);

    expect(reply.getStatus()).toBe(503);
  });

  it('heartbeat returns 503 when no peer repo', async () => {
    const app = createMockApp();
    registerFederationRoutes(app as never);

    const handler = app.getHandler('POST', '/api/federation/peers/heartbeat')!;
    const reply = createMockReply();
    await handler({ body: {} }, reply);

    expect(reply.getStatus()).toBe(503);
  });
});
