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

  it('refuses to acquire when an alive holder is recorded', () => {
    // Simulate an alive holder by writing the current PID into the lock
    // file (the test process is, by definition, alive).
    const lockPath = lockPathFor(env.dataDir);
    writeFileSync(lockPath, `${process.pid}\n`, 'utf8');

    const handle = acquireProcessLock({ dataDir: env.dataDir });
    expect(handle.acquired).toBe(false);
    expect(handle.holder).toBe(process.pid);
    expect(handle.hint).toMatch(/Another Memphis instance/);

    // Lock file is intact (we did not overwrite a live holder).
    expect(readFileSync(lockPath, 'utf8').trim()).toBe(String(process.pid));
  });

  it('reclaims a stale lock when the recorded holder is dead', () => {
    // PID 1 (init) is alive on every system. PID 999_999_999 (1B) is
    // virtually guaranteed dead — exceeds Linux PID_MAX (4_194_304) and
    // macOS 99999. We use that as our "dead PID".
    const deadPid = 999_999_999;
    const lockPath = lockPathFor(env.dataDir);
    writeFileSync(lockPath, `${deadPid}\n`, 'utf8');

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
    writeFileSync(lockPath, `999999999\n`, 'utf8');
    const peek = peekProcessLock(env.dataDir);
    expect(peek.holder).toBe(999_999_999);
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
});
