import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { createSqliteClient, runMigrations } from '../../src/infra/storage/sqlite/client.js';
import { SqliteWorkItemRepository } from '../../src/infra/storage/sqlite/repositories/work-item-repository.js';
import { SqliteWorkerSessionRepository } from '../../src/infra/storage/sqlite/repositories/worker-session-repository.js';
import { CapacityWake } from '../../src/infra/work/capacity-wake.js';
import { SessionTokenService } from '../../src/infra/work/session-token-service.js';
import { WorkPollingService } from '../../src/infra/work/work-polling-service.js';

describe('work polling service', () => {
  it('leases, heartbeats, and completes work for an authenticated worker session', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'memphis-work-polling-'));
    const db = createSqliteClient(`file:${join(dir, 'runtime.db')}`);
    runMigrations(db);

    try {
      const service = new WorkPollingService(
        new SqliteWorkerSessionRepository(db),
        new SqliteWorkItemRepository(db),
        new SessionTokenService('0123456789abcdef0123456789abcdef'),
        new CapacityWake(),
        { sessionTtlMs: 60_000, leaseTtlMs: 10_000 },
      );

      const registration = service.registerWorker({
        workerId: 'worker-alpha',
        capabilityScope: ['tools:read'],
      });
      const auth = service.authenticateToken(registration.token);
      const refreshed = service.refreshSession(auth);
      expect(refreshed.token).toEqual(expect.any(String));
      expect(refreshed.expiresAtMs).toBeGreaterThan(Date.now());

      const enqueued = service.enqueueWork({
        type: 'chat.generate',
        actorId: 'telegram:7',
        conversationId: 'primary::telegram:7',
        capabilityScope: ['tools:read'],
        payload: { input: 'summarize latest memory' },
      });
      expect(enqueued.status).toBe('pending');

      const leased = await service.poll(auth, { waitMs: 1 });
      expect(leased).toMatchObject({
        type: 'chat.generate',
        actorId: 'telegram:7',
        conversationId: 'primary::telegram:7',
        status: 'leased',
      });

      const acknowledged = service.acknowledgeWork(auth, leased!.workId);
      expect(acknowledged.status).toBe('leased');
      expect(acknowledged.leaseExpiresAtMs).toBeGreaterThan(Date.now());

      const heartbeat = service.heartbeat(auth, leased!.workId);
      expect(heartbeat.heartbeatAtMs).toBeGreaterThan(0);

      const completed = service.completeWork(auth, {
        workId: leased!.workId,
        status: 'completed',
        result: { ok: true, output: 'done' },
      });
      expect(completed.status).toBe('completed');
      expect(completed.result).toMatchObject({ ok: true, output: 'done' });
      expect(service.snapshot()).toMatchObject({
        tokenReady: true,
        sessions: expect.objectContaining({ total: 1, active: 1 }),
        work: expect.objectContaining({ total: 1, completed: 1 }),
      });

      const revoked = service.revokeSession(registration.session.sessionId);
      expect(revoked.revokedAt).toEqual(expect.any(String));
      expect(() => service.authenticateToken(refreshed.token)).toThrow(/stale|revoked/i);
    } finally {
      db.close();
    }
  });
});
