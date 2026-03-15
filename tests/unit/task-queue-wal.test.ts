import { appendFileSync, mkdtempSync, readFileSync, statSync, truncateSync } from 'node:fs';
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
});
