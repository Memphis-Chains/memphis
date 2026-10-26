import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  acquireProcessLock,
  lockPathFor,
  peekProcessLock,
} from '../../src/infra/runtime/process-lock.js';

interface LockEnv {
  dataDir: string;
}

function setup(): LockEnv {
  const dataDir = mkdtempSync(join(tmpdir(), 'memphis-process-lock-'));
  return { dataDir };
}

function teardown(env: LockEnv): void {
  rmSync(env.dataDir, { recursive: true, force: true });
}

describe('process-lock — singleton acquisition', () => {
  let env: LockEnv;

  beforeEach(() => {
    env = setup();
  });

  afterEach(() => {
    teardown(env);
  });

  it('acquires the lock when no holder exists', () => {
    const handle = acquireProcessLock({ dataDir: env.dataDir });
    expect(handle.acquired).toBe(true);
    expect(handle.holder).toBe(process.pid);
    expect(existsSync(lockPathFor(env.dataDir))).toBe(true);

    handle.release();
    // After release, the lock file is removed.
    expect(existsSync(lockPathFor(env.dataDir))).toBe(false);
  });

  it('records the holder identity, not only its PID', () => {
    const handle = acquireProcessLock({ dataDir: env.dataDir });
    try {
      const raw = readFileSync(lockPathFor(env.dataDir), 'utf8').trim();
      const record = JSON.parse(raw) as { pid: number; bootId: string; startTime: number };
      expect(record.pid).toBe(process.pid);
      // A PID alone is not an identity: the kernel reuses numbers after a
      // reboot. The boot ID and the start time are what make the record
      // unambiguous.
      expect(typeof record.bootId).toBe('string');
      expect(record.startTime).toBeGreaterThan(0);
    } finally {
      handle.release();
    }
  });

  it('refuses to acquire when an alive holder is recorded', () => {
    // The first acquisition writes this process's real identity. A second
    // acquisition must see that exact process as the live holder and
    // refuse — this is the case the lock exists for.
    const first = acquireProcessLock({ dataDir: env.dataDir });
    expect(first.acquired).toBe(true);
    const lockPath = lockPathFor(env.dataDir);
    const record = readFileSync(lockPath, 'utf8').trim();

    const second = acquireProcessLock({ dataDir: env.dataDir });
    expect(second.acquired).toBe(false);
    expect(second.holder).toBe(process.pid);
    expect(second.hint).toMatch(/Another Memphis instance/);

    // Lock file is intact (we did not overwrite a live holder).
    expect(readFileSync(lockPath, 'utf8').trim()).toBe(record);

    first.release();
  });

  it('reclaims a stale lock when the recorded holder is dead', () => {
    // PID 1 (init) is alive on every system. PID 999_999_999 (1B) is
    // virtually guaranteed dead — exceeds Linux PID_MAX (4_194_304) and
    // macOS 99999. We use that as our "dead PID".
    const deadPid = 999_999_999;
    const lockPath = lockPathFor(env.dataDir);
    writeFileSync(
      lockPath,
      `${JSON.stringify({ pid: deadPid, bootId: '', startTime: 0 })}\n`,
      'utf8',
    );

    const handle = acquireProcessLock({ dataDir: env.dataDir });
    expect(handle.acquired).toBe(true);
    expect(handle.holder).toBe(process.pid);
    expect(handle.hint).toMatch(/stale lock/);

    handle.release();
  });

  it('reclaims a lock whose boot ID no longer matches — PID recycled after a reboot', () => {
    // 2026-10-23 incident: after a reboot the kernel handed the old daemon's
    // PID to an unrelated live process. The old check (PID alive) said
    // "another instance is running" and the daemon refused to start.
    // The recorded boot ID is from a different boot, so the holder is stale
    // even though the PID is alive right now.
    const livePid = process.pid;
    const lockPath = lockPathFor(env.dataDir);
    writeFileSync(
      lockPath,
      `${JSON.stringify({ pid: livePid, bootId: 'boot-id-from-a-previous-boot', startTime: 12345 })}\n`,
      'utf8',
    );

    const handle = acquireProcessLock({ dataDir: env.dataDir });
    expect(handle.acquired).toBe(true);
    expect(handle.holder).toBe(process.pid);
    expect(handle.hint).toMatch(/stale lock/);

    handle.release();
  });

  it('reclaims a lock whose start time differs — PID recycled within one boot', () => {
    // Same boot, but the PID was reused by a different process: the
    // recorded start time no longer matches the live one.
    const lockPath = lockPathFor(env.dataDir);
    const record = JSON.stringify({
      pid: process.pid,
      bootId: readBootId(),
      startTime: 999_999,
    });
    writeFileSync(lockPath, `${record}\n`, 'utf8');

    const handle = acquireProcessLock({ dataDir: env.dataDir });
    expect(handle.acquired).toBe(true);
    expect(handle.holder).toBe(process.pid);
    expect(handle.hint).toMatch(/stale lock/);

    handle.release();
  });

  it('peekProcessLock reports holder + alive status without acquiring', () => {
    const peekEmpty = peekProcessLock(env.dataDir);
    expect(peekEmpty.holder).toBeNull();
    expect(peekEmpty.alive).toBe(false);

    const handle = acquireProcessLock({ dataDir: env.dataDir });
    try {
      const peek = peekProcessLock(env.dataDir);
      expect(peek.holder).toBe(process.pid);
      expect(peek.alive).toBe(true);
      expect(peek.lockPath).toBe(lockPathFor(env.dataDir));
    } finally {
      handle.release();
    }
  });

  it('peekProcessLock reports stale lock as alive=false', () => {
    const lockPath = lockPathFor(env.dataDir);
    writeFileSync(lockPath, `{"pid":999999999,"bootId":"","startTime":0}\n`, 'utf8');
    const peek = peekProcessLock(env.dataDir);
    expect(peek.holder).toBe(999_999_999);
    expect(peek.alive).toBe(false);
  });

  it('peekProcessLock reports a lock from a previous boot as not alive', () => {
    // The PID is live right now, but the lock was written before a reboot.
    const lockPath = lockPathFor(env.dataDir);
    writeFileSync(
      lockPath,
      `${JSON.stringify({ pid: process.pid, bootId: 'a-different-boot', startTime: 1 })}\n`,
      'utf8',
    );
    const peek = peekProcessLock(env.dataDir);
    expect(peek.holder).toBe(process.pid);
    expect(peek.alive).toBe(false);
  });

  it('handles invalid PID file gracefully', () => {
    const lockPath = lockPathFor(env.dataDir);
    writeFileSync(lockPath, 'not-a-number\n', 'utf8');
    const peek = peekProcessLock(env.dataDir);
    expect(peek.holder).toBeNull();

    // Acquisition should overwrite the garbage.
    const handle = acquireProcessLock({ dataDir: env.dataDir });
    expect(handle.acquired).toBe(true);
    handle.release();
  });

  it('reclaims a legacy bare-PID lock file — the record cannot be verified', () => {
    // Lock files written before 2026-10-23 contain a bare PID and no
    // identity. That record cannot distinguish "the daemon is running" from
    // "the kernel reused this number for something else" — the exact
    // ambiguity that left the daemon down after the 2026-10-23 reboot.
    // An unverifiable record must not block the boot.
    const lockPath = lockPathFor(env.dataDir);
    writeFileSync(lockPath, `${process.pid}\n`, 'utf8');

    const handle = acquireProcessLock({ dataDir: env.dataDir });
    expect(handle.acquired).toBe(true);
    expect(handle.holder).toBe(process.pid);

    handle.release();
  });

  it('peekProcessLock reports a legacy bare-PID lock as not alive', () => {
    const lockPath = lockPathFor(env.dataDir);
    writeFileSync(lockPath, `${process.pid}\n`, 'utf8');
    const peek = peekProcessLock(env.dataDir);
    expect(peek.holder).toBe(process.pid);
    expect(peek.alive).toBe(false);
  });
});

/** The current boot ID, for records that must match this boot. */
function readBootId(): string {
  try {
    return readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim();
  } catch {
    return '';
  }
}
