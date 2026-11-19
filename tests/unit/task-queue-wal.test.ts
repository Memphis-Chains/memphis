import {
  appendFileSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  statSync,
  truncateSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { TaskQueueWal } from '../../src/infra/storage/task-queue-wal.js';

describe('task queue WAL', () => {
  it('recovers by truncating torn tail record', () => {
    const dir = mkdtempSync(join(tmpdir(), 'memphis-wal-'));
    const walPath = join(dir, 'queue.wal');
    const wal = new TaskQueueWal({ walPath, mode: 'financial' });

    wal.enqueue({ id: 'task-1', prompt: 'hello' });
    appendFileSync(walPath, Buffer.from([0, 0, 0, 20, 1, 2, 3, 4])); // torn/invalid tail

    const before = statSync(walPath).size;
    const records = wal.recoverAndRead();
    const after = statSync(walPath).size;

    expect(records).toHaveLength(1);
    expect(records[0]?.payload).toContain('task-1');
    expect(after).toBeLessThan(before);
  });

  it('supports deterministic fault injection before wal rename sync', () => {
    const dir = mkdtempSync(join(tmpdir(), 'memphis-wal-fault-'));
    const walPath = join(dir, 'queue.wal');
    const wal = new TaskQueueWal({
      walPath,
      mode: 'financial',
      maxWalBytes: 90,
      faultInject: 'wal-rename-pre-sync',
    });

    wal.enqueue({ id: 'task-1', payload: 'x'.repeat(40) });

    expect(() =>
      wal.enqueue({
        id: 'task-2',
        payload: 'x'.repeat(40),
      }),
    ).toThrow(/fault-inject: wal-rename-pre-sync/);

    // WAL remains parseable (existing data survives despite injected fault).
    const restored = new TaskQueueWal({ walPath, mode: 'financial' });
    const records = restored.recoverAndRead();
    expect(records.length).toBeGreaterThanOrEqual(1);
    const text = readFileSync(walPath, 'utf8');
    expect(typeof text).toBe('string');
  });

  it('truncates invalid tail bytes after manual corruption', () => {
    const dir = mkdtempSync(join(tmpdir(), 'memphis-wal-corrupt-'));
    const walPath = join(dir, 'queue.wal');
    const wal = new TaskQueueWal({ walPath, mode: 'financial' });
    wal.enqueue({ id: 'task-ok' });

    const bytes = readFileSync(walPath);
    truncateSync(walPath, Math.max(1, Math.floor(bytes.length / 2)));

    const recovered = wal.recoverAndRead();
    expect(recovered).toHaveLength(0);
  });

  it('takes over an orphaned lock whose process identity is dead', () => {
    const dir = mkdtempSync(join(tmpdir(), 'memphis-wal-stale-lock-'));
    const walPath = join(dir, 'queue.wal');
    const lockPath = `${walPath}.lock`;
    writeFileSync(
      lockPath,
      `${JSON.stringify({
        pid: 999_999_999,
        bootId: 'dead-boot',
        startTime: 1,
        token: 'orphan',
      })}\n`,
    );

    const wal = new TaskQueueWal({ walPath, lockTimeoutMs: 100 });
    expect(() => wal.enqueue({ id: 'after-orphan' })).not.toThrow();
    expect(wal.recoverAndRead()).toHaveLength(1);
    expect(existsSync(lockPath)).toBe(false);
  });

  it('takes over a malformed lock after one timeout instead of wedging forever', () => {
    const dir = mkdtempSync(join(tmpdir(), 'memphis-wal-malformed-lock-'));
    const walPath = join(dir, 'queue.wal');
    const lockPath = `${walPath}.lock`;
    writeFileSync(lockPath, '');

    const wal = new TaskQueueWal({ walPath, lockTimeoutMs: 20 });
    expect(() => wal.enqueue({ id: 'after-malformed-orphan' })).not.toThrow();
    expect(wal.recoverAndRead()).toHaveLength(1);
    expect(existsSync(lockPath)).toBe(false);
  });

  it('does not take over a lock held by this live process', () => {
    if (process.platform !== 'linux') return;
    const dir = mkdtempSync(join(tmpdir(), 'memphis-wal-live-lock-'));
    const walPath = join(dir, 'queue.wal');
    const lockPath = `${walPath}.lock`;
    const procStat = readFileSync(`/proc/${process.pid}/stat`, 'utf8');
    const close = procStat.lastIndexOf(')');
    const startTime = Number.parseInt(procStat.slice(close + 2).split(' ')[19]!, 10);
    const bootId = readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim();
    writeFileSync(
      lockPath,
      `${JSON.stringify({ pid: process.pid, bootId, startTime, token: 'live-owner' })}\n`,
    );

    const wal = new TaskQueueWal({ walPath, lockTimeoutMs: 20 });
    expect(() => wal.enqueue({ id: 'must-wait' })).toThrow(/lock timeout/);
    expect(existsSync(lockPath)).toBe(true);
  });

  it('releases the lock when the critical section throws', () => {
    const dir = mkdtempSync(join(tmpdir(), 'memphis-wal-callback-error-'));
    const walPath = join(dir, 'queue.wal');
    const wal = new TaskQueueWal({
      walPath,
      maxWalBytes: 1,
      faultInject: 'wal-rename-pre-sync',
    });

    expect(() => wal.enqueue({ id: 'callback-error' })).toThrow(/fault-inject/);
    expect(existsSync(`${walPath}.lock`)).toBe(false);
  });
});
