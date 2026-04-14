import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  __resetTurnAdmissionForTests,
  acquireTurnSlot,
  DEFAULT_MAX_CONCURRENT_TURNS,
  getAdmissionState,
  previewQueueState,
} from '../../src/infra/runtime/turn-admission.js';

describe('turn admission control (Phase 2.2 production sprint)', () => {
  beforeEach(() => {
    __resetTurnAdmissionForTests();
  });

  afterEach(() => {
    __resetTurnAdmissionForTests();
  });

  it('admits immediately when below cap', async () => {
    const ticket = await acquireTurnSlot({
      MEMPHIS_MAX_CONCURRENT_TURNS: '5',
    } as NodeJS.ProcessEnv);
    expect(ticket.queuePositionAtEntry).toBe(0);
    expect(ticket.estimatedWaitMs).toBe(0);
    expect(getAdmissionState().active).toBe(1);
    ticket.release();
    expect(getAdmissionState().active).toBe(0);
  });

  it('queues when at cap; admits when slot frees', async () => {
    const env = { MEMPHIS_MAX_CONCURRENT_TURNS: '2' } as NodeJS.ProcessEnv;
    const a = await acquireTurnSlot(env);
    const b = await acquireTurnSlot(env);
    // Both acquired
    expect(getAdmissionState().active).toBe(2);

    // Third caller must queue
    const cPromise = acquireTurnSlot(env);
    // Give the queue a tick to register
    await Promise.resolve();
    expect(getAdmissionState().queued).toBe(1);

    // Free a slot — third caller should now resolve
    a.release();
    const c = await cPromise;
    expect(c.queuePositionAtEntry).toBe(0);
    expect(getAdmissionState().active).toBe(2);

    // Cleanup
    b.release();
    c.release();
  });

  it('rejects with 429 when queue depth exceeds cap', async () => {
    const env = {
      MEMPHIS_MAX_CONCURRENT_TURNS: '1',
      MEMPHIS_MAX_QUEUED_TURNS: '2',
    } as NodeJS.ProcessEnv;
    const a = await acquireTurnSlot(env);
    // Queue 2
    const p1 = acquireTurnSlot(env);
    const p2 = acquireTurnSlot(env);
    await Promise.resolve();
    expect(getAdmissionState().queued).toBe(2);

    // Third would-be queuer is rejected
    await expect(acquireTurnSlot(env)).rejects.toThrow(/turn admission refused/);

    // Cleanup — release a so queued ones can resolve
    a.release();
    const r1 = await p1;
    r1.release();
    const r2 = await p2;
    r2.release();
  });

  it('queuePositionAtEntry reflects depth at the moment of enqueue', async () => {
    const env = { MEMPHIS_MAX_CONCURRENT_TURNS: '1' } as NodeJS.ProcessEnv;
    const head = await acquireTurnSlot(env);
    const p1 = acquireTurnSlot(env);
    const p2 = acquireTurnSlot(env);
    const p3 = acquireTurnSlot(env);

    head.release();
    const r1 = await p1;
    expect(r1.queuePositionAtEntry).toBe(0);
    r1.release();
    const r2 = await p2;
    expect(r2.queuePositionAtEntry).toBe(1);
    r2.release();
    const r3 = await p3;
    expect(r3.queuePositionAtEntry).toBe(2);
    r3.release();
  });

  it('previewQueueState gives synchronous "you will queue" hint', async () => {
    const env = { MEMPHIS_MAX_CONCURRENT_TURNS: '1' } as NodeJS.ProcessEnv;
    process.env.MEMPHIS_MAX_CONCURRENT_TURNS = '1';
    process.env.MEMPHIS_MAX_QUEUED_TURNS = '5';
    try {
      const head = await acquireTurnSlot(env);
      const preview = previewQueueState();
      expect(preview.willQueue).toBe(true);
      expect(preview.willReject).toBe(false);
      expect(preview.active).toBe(1);
      head.release();
    } finally {
      delete process.env.MEMPHIS_MAX_CONCURRENT_TURNS;
      delete process.env.MEMPHIS_MAX_QUEUED_TURNS;
    }
  });

  it('release() is idempotent (double-release is a no-op)', async () => {
    const ticket = await acquireTurnSlot({} as NodeJS.ProcessEnv);
    ticket.release();
    expect(getAdmissionState().active).toBe(0);
    ticket.release(); // noop
    expect(getAdmissionState().active).toBe(0);
  });

  it('uses default cap when env unset', async () => {
    const tickets = [];
    for (let i = 0; i < DEFAULT_MAX_CONCURRENT_TURNS; i += 1) {
      tickets.push(await acquireTurnSlot({} as NodeJS.ProcessEnv));
    }
    expect(getAdmissionState().active).toBe(DEFAULT_MAX_CONCURRENT_TURNS);
    for (const t of tickets) t.release();
  });

  it('Codex Round 6 P1: raising MEMPHIS_MAX_CONCURRENT_TURNS drains queue to new cap', async () => {
    const savedMax = process.env.MEMPHIS_MAX_CONCURRENT_TURNS;
    process.env.MEMPHIS_MAX_CONCURRENT_TURNS = '1';
    try {
      // Acquire 1 (cap) + queue 3
      const a = await acquireTurnSlot(process.env);
      const p1 = acquireTurnSlot(process.env);
      const p2 = acquireTurnSlot(process.env);
      const p3 = acquireTurnSlot(process.env);
      await Promise.resolve();
      expect(getAdmissionState().queued).toBe(3);

      // Raise cap mid-flight
      process.env.MEMPHIS_MAX_CONCURRENT_TURNS = '4';

      // Release a — admitOne should now pump ALL queued callers
      // immediately because the new cap allows it.
      a.release();
      const r1 = await p1;
      const r2 = await p2;
      const r3 = await p3;
      expect(getAdmissionState().active).toBe(3);
      expect(getAdmissionState().queued).toBe(0);

      r1.release();
      r2.release();
      r3.release();
    } finally {
      if (savedMax !== undefined) process.env.MEMPHIS_MAX_CONCURRENT_TURNS = savedMax;
      else delete process.env.MEMPHIS_MAX_CONCURRENT_TURNS;
    }
  });

  it('Codex Round 6 P1: lowering MEMPHIS_MAX_CONCURRENT_TURNS stops admission until active drains', async () => {
    const savedMax = process.env.MEMPHIS_MAX_CONCURRENT_TURNS;
    process.env.MEMPHIS_MAX_CONCURRENT_TURNS = '3';
    try {
      const a = await acquireTurnSlot(process.env);
      const b = await acquireTurnSlot(process.env);
      const c = await acquireTurnSlot(process.env);
      const p1 = acquireTurnSlot(process.env);
      await Promise.resolve();
      expect(getAdmissionState().queued).toBe(1);

      // Operator lowers cap to 1 — but 3 are already active.
      process.env.MEMPHIS_MAX_CONCURRENT_TURNS = '1';

      // Release one — admitOne must NOT admit the queued caller
      // because active (2) is still above the new cap (1).
      a.release();
      await Promise.resolve();
      expect(getAdmissionState().queued).toBe(1);

      // Release the rest — once active drops below 1 again, queue admits.
      b.release();
      c.release();
      const r1 = await p1;
      expect(getAdmissionState().active).toBe(1);
      r1.release();
    } finally {
      if (savedMax !== undefined) process.env.MEMPHIS_MAX_CONCURRENT_TURNS = savedMax;
      else delete process.env.MEMPHIS_MAX_CONCURRENT_TURNS;
    }
  });

  it('totalAdmitted and totalQueued counters track lifetime traffic', async () => {
    const env = { MEMPHIS_MAX_CONCURRENT_TURNS: '1' } as NodeJS.ProcessEnv;
    const a = await acquireTurnSlot(env);
    const p1 = acquireTurnSlot(env);
    a.release();
    const r1 = await p1;
    r1.release();
    const s = getAdmissionState();
    expect(s.totalAdmitted).toBe(2);
    expect(s.totalQueued).toBe(1);
  });
});
