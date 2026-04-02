import { describe, expect, it } from 'vitest';

import { SessionTokenService } from '../../src/infra/work/session-token-service.js';

describe('session token service', () => {
  it('issues and verifies signed worker session tokens', () => {
    const service = new SessionTokenService('0123456789abcdef0123456789abcdef');
    const token = service.issue({
      sessionId: 'session-1',
      workerId: 'worker-1',
      capabilityScope: ['tool:read', 'memory:read'],
      expiresAtMs: Date.now() + 60_000,
      epoch: 2,
    });

    const claims = service.verify(token);
    expect(claims).toMatchObject({
      sid: 'session-1',
      wid: 'worker-1',
      scope: ['tool:read', 'memory:read'],
      epoch: 2,
    });
  });

  it('rejects tampered or expired tokens', () => {
    const service = new SessionTokenService('0123456789abcdef0123456789abcdef');
    const token = service.issue({
      sessionId: 'session-1',
      workerId: 'worker-1',
      capabilityScope: [],
      expiresAtMs: Date.now() + 10,
      epoch: 1,
    });

    expect(() => service.verify(`${token}oops`)).toThrow(/invalid session token/i);
    expect(() => service.verify(token, Date.now() + 100)).toThrow(/expired/i);
  });
});
