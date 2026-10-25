import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

const fault = vi.hoisted(() => ({
  target: '',
  primary: undefined as Error | undefined,
  unlink: undefined as Error | undefined,
  close: undefined as Error | undefined,
  descriptors: new Set<number>(),
}));
vi.mock('node:fs', async (original) => {
  const actual = await original<typeof import('node:fs')>();
  return {
    ...actual,
    openSync: (...args: Parameters<typeof actual.openSync>) => {
      const fd = actual.openSync(...args);
      if (fault.target && String(args[0]).startsWith(fault.target + '.tmp-'))
        fault.descriptors.add(fd);
      return fd;
    },
    writeFileSync: (...args: Parameters<typeof actual.writeFileSync>) => {
      if (typeof args[0] === 'number' && fault.descriptors.has(args[0]) && fault.primary)
        throw fault.primary;
      return actual.writeFileSync(...args);
    },
    closeSync: (fd: number) => {
      const tracked = fault.descriptors.delete(fd);
      actual.closeSync(fd);
      if (tracked && fault.close) throw fault.close;
    },
    unlinkSync: (path: Parameters<typeof actual.unlinkSync>[0]) => {
      if (fault.target && String(path).startsWith(fault.target + '.tmp-') && fault.unlink)
        throw fault.unlink;
      return actual.unlinkSync(path);
    },
  };
});

import { writePrivateAtomicFile } from '../../src/infra/config/private-atomic-file.js';

const roots: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  fault.target = '';
  fault.primary = undefined;
  fault.unlink = undefined;
  fault.close = undefined;
  fault.descriptors.clear();
  roots.splice(0).forEach((p) => rmSync(p, { recursive: true, force: true }));
});

describe('private atomic write secondary failures', () => {
  it.each(['unlink', 'close-and-unlink', 'unknown-unlink-code', 'stderr-failure'] as const)(
    '%s preserves the primary storage error without private stderr context',
    (mode) => {
      const root = mkdtempSync(join(tmpdir(), 'memphis-atomic-error-'));
      roots.push(root);
      fault.target = join(root, 'synthetic-private-target.json');
      const primary = Object.assign(new Error('synthetic-private-primary-value'), {
        code: 'ENOSPC',
      });
      fault.primary = primary;
      fault.unlink = Object.assign(new Error('synthetic-private-unlink-value'), {
        code: mode === 'unknown-unlink-code' ? 'synthetic-private-error-code' : 'EACCES',
      });
      if (mode === 'close-and-unlink')
        fault.close = Object.assign(new Error('synthetic-private-close-value'), { code: 'EIO' });
      const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => {
        if (mode === 'stderr-failure') throw new Error('synthetic-private-warning-error');
        return true;
      });
      let failure: unknown;
      try {
        writePrivateAtomicFile(fault.target, 'synthetic-private-file-content');
      } catch (error) {
        failure = error;
      }
      expect(failure).toBe(primary);
      const messages = stderr.mock.calls.map(([s]) => String(s)).join('');
      expect(messages).not.toContain('synthetic-private');
      expect(messages).not.toContain(root);
      expect(messages).toContain(
        mode === 'unknown-unlink-code' ? 'PRIVATE_ATOMIC_CLEANUP_FAILED' : 'EACCES',
      );
      if (mode === 'close-and-unlink') expect(messages).toContain('EIO');
      expect(fault.descriptors.size).toBe(0);
      // Cleanup failure is truthful: the temporary remains for private recovery.
      expect(readdirSync(root).some((name) => name.includes('.tmp-'))).toBe(true);
    },
  );
});
