/**
 * Sprint 8 release hardening tests:
 * - Model D latency in metrics snapshot
 * - Task queue status route shape
 * - Dual-approval listPendingByAction
 * - Trust-root downgrade rejection
 */

import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { InMemoryMetrics } from '../../src/infra/logging/metrics.js';
import { evaluateTrustRootDowngrade } from '../../src/infra/runtime/startup-guards.js';

describe('Model D metrics latency in snapshot', () => {
  it('exposes latency fields after recording proposals', () => {
    const m = new InMemoryMetrics();
    m.recordModelDProposal('approve', 150);
    m.recordModelDProposal('reject', 250);

    const snap = m.snapshot();
    expect(snap.modelD.latencyCount).toBe(2);
    expect(snap.modelD.latencySumSeconds).toBeCloseTo(0.4, 2);
    expect(snap.modelD.avgLatencyMs).toBe(200);
    expect(snap.modelD.proposalsTotal).toBe(2);
  });

  it('avgLatencyMs is 0 when no proposals recorded', () => {
    const m = new InMemoryMetrics();
    const snap = m.snapshot();
    expect(snap.modelD.latencyCount).toBe(0);
    expect(snap.modelD.avgLatencyMs).toBe(0);
  });

  it('exposes scheduler runtime posture and fallback counters in metrics snapshot and Prometheus', () => {
    const m = new InMemoryMetrics();
    m.observeSchedulerRuntime({
      configuredTarget: 'workers',
      effectiveTarget: 'local',
      running: true,
      intervalMs: 30_000,
      workerLaneReady: false,
      fallbackReason: 'worker session tokens are not ready; using local execution',
      tasks: {
        total: 3,
        enabled: 2,
        overdue: 1,
      },
    });

    const snap = m.snapshot();
    expect(snap.schedule.runtime).toMatchObject({
      configuredTarget: 'workers',
      effectiveTarget: 'local',
      running: true,
      workerLaneReady: false,
      fallbackActive: true,
      fallbacksTotal: 1,
      tasks: {
        total: 3,
        enabled: 2,
        overdue: 1,
      },
    });

    const prom = m.toPrometheus();
    expect(prom).toContain('scheduler_runtime_target{phase="configured",target="workers"} 1');
    expect(prom).toContain('scheduler_runtime_target{phase="effective",target="local"} 1');
    expect(prom).toContain('scheduler_fallback_total 1');
    expect(prom).toContain('scheduler_tasks_overdue 1');
  });
});

describe('trust-root downgrade rejection', () => {
  let tmpDir: string;

  it('allows when no current trust root exists', () => {
    const result = evaluateTrustRootDowngrade(null, { version: 1 });
    expect(result.allowed).toBe(true);
    expect(result.incomingVersion).toBe(1);
  });

  it('allows when current path does not exist on disk', () => {
    const result = evaluateTrustRootDowngrade('/nonexistent/trust_root.json', { version: 2 });
    expect(result.allowed).toBe(true);
  });

  it('rejects downgrade from v3 to v2', () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'memphis-trust-'));
    const path = join(tmpDir, 'trust_root.json');
    writeFileSync(path, JSON.stringify({ version: 3, rootIds: ['root-1'] }));

    const result = evaluateTrustRootDowngrade(path, { version: 2 });
    expect(result.allowed).toBe(false);
    expect(result.currentVersion).toBe(3);
    expect(result.incomingVersion).toBe(2);
    expect(result.reason).toContain('downgrade rejected');
  });

  it('allows upgrade from v3 to v4', () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'memphis-trust-'));
    const path = join(tmpDir, 'trust_root.json');
    writeFileSync(path, JSON.stringify({ version: 3, rootIds: ['root-1'] }));

    const result = evaluateTrustRootDowngrade(path, { version: 4 });
    expect(result.allowed).toBe(true);
    expect(result.currentVersion).toBe(3);
    expect(result.incomingVersion).toBe(4);
  });

  it('allows same version (not a downgrade)', () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'memphis-trust-'));
    const path = join(tmpDir, 'trust_root.json');
    writeFileSync(path, JSON.stringify({ version: 5, rootIds: ['root-1'] }));

    const result = evaluateTrustRootDowngrade(path, { version: 5 });
    expect(result.allowed).toBe(true);
  });

  it('rejects incoming manifest with no version', () => {
    const result = evaluateTrustRootDowngrade(null, {});
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain('no valid integer version');
  });

  it('accepts incoming when current manifest is malformed', () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'memphis-trust-'));
    const path = join(tmpDir, 'trust_root.json');
    writeFileSync(path, 'not-json!!!');

    const result = evaluateTrustRootDowngrade(path, { version: 1 });
    expect(result.allowed).toBe(true);
    expect(result.reason).toContain('unreadable');
  });
});

describe('dual-approval listPendingByAction', () => {
  it('lists pending freeze and unfreeze requests separately', async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), 'memphis-dual-'));
    const dbPath = join(tmpDir, 'test.db');

    const { createSqliteClient, runMigrations } =
      await import('../../src/infra/storage/sqlite/client.js');
    const { SqliteDualApprovalRepository } =
      await import('../../src/infra/storage/sqlite/repositories/dual-approval-repository.js');

    const db = createSqliteClient(`file:${dbPath}`);
    runMigrations(db);
    const repo = new SqliteDualApprovalRepository(db);

    repo.createRequest({ action: 'freeze', initiatorId: 'alice' });
    repo.createRequest({ action: 'unfreeze', initiatorId: 'bob' });
    repo.createRequest({ action: 'freeze', initiatorId: 'carol' });

    const allPending = repo.listPendingByAction();
    expect(allPending.length).toBe(3);

    const freezePending = repo.listPendingByAction('freeze');
    expect(freezePending.length).toBe(2);
    expect(freezePending.every((r) => r.action === 'freeze')).toBe(true);

    const unfreezePending = repo.listPendingByAction('unfreeze');
    expect(unfreezePending.length).toBe(1);
    expect(unfreezePending[0]!.action).toBe('unfreeze');
  });
});

describe('task queue service snapshot shape', () => {
  it('exposes queue snapshot with expected fields', async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), 'memphis-tq-'));
    mkdirSync(tmpDir, { recursive: true });

    const { TaskQueueService } = await import('../../src/infra/storage/task-queue-service.js');

    const tq = new TaskQueueService({ walPath: join(tmpDir, 'test.wal') });
    const snap = tq.snapshot();

    expect(snap).toHaveProperty('mode');
    expect(snap).toHaveProperty('resumePolicy');
    expect(snap).toHaveProperty('maxPendingTasks');
    expect(snap).toHaveProperty('pendingTasks');
    expect(snap).toHaveProperty('totalEnqueued');
    expect(snap).toHaveProperty('totalFinished');
    expect(snap.mode).toBe('financial');
    expect(snap.pendingTasks).toBe(0);
  });

  it('enqueue increases pending count and finish decreases it', async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), 'memphis-tq-'));
    mkdirSync(tmpDir, { recursive: true });

    const { TaskQueueService } = await import('../../src/infra/storage/task-queue-service.js');

    const tq = new TaskQueueService({ walPath: join(tmpDir, 'test.wal') });
    const ticket = tq.enqueue({ type: 'test.task' });
    expect(tq.snapshot().pendingTasks).toBe(1);
    expect(tq.snapshot().totalEnqueued).toBe(1);

    tq.finish(ticket.taskId, 'completed');
    expect(tq.snapshot().pendingTasks).toBe(0);
    expect(tq.snapshot().totalFinished).toBe(1);
  });
});
