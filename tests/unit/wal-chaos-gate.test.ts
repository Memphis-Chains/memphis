import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { TaskQueueWal } from '../../src/infra/storage/task-queue-wal.js';

describe('chaos gate: wal fault injection', () => {
  afterEach(() => {
    delete process.env.MEMPHIS_FAULT_INJECT;
  });

  it('honors MEMPHIS_FAULT_INJECT=wal-rename-pre-sync during rotation', () => {
    process.env.MEMPHIS_FAULT_INJECT = 'wal-rename-pre-sync';

    const dir = mkdtempSync(join(tmpdir(), 'memphis-chaos-wal-'));
    const walPath = join(dir, 'queue.wal');
    const wal = new TaskQueueWal({
      walPath,
      mode: 'financial',
      maxWalBytes: 90,
    });

    wal.enqueue({ id: 'task-1', payload: 'x'.repeat(40) });
    expect(() =>
      wal.enqueue({
        id: 'task-2',
        payload: 'x'.repeat(40),
      }),
    ).toThrow(/fault-inject: wal-rename-pre-sync/);
  });
});
