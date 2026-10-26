import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, expect, it, vi } from 'vitest';

const command = vi.hoisted(() => vi.fn());
vi.mock('node:child_process', () => ({ spawnSync: command }));
import {
  acquireProcessLock,
  lockPathFor,
  peekProcessLock,
} from '../../src/infra/runtime/process-lock.js';

const platform = Object.getOwnPropertyDescriptor(process, 'platform')!;
const roots: string[] = [];
afterEach(() => {
  Object.defineProperty(process, 'platform', platform);
  roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true }));
  command.mockReset();
});

it('identifies a live macOS holder and detects boot and PID reuse', () => {
  Object.defineProperty(process, 'platform', { ...platform, value: 'darwin' });
  command.mockImplementation((file: string) => ({
    status: 0,
    stdout: file.endsWith('sysctl') ? 'boot-session-A\n' : 'Mon Oct 26 12:00:00 2026\n',
  }));
  const dataDir = mkdtempSync(join(tmpdir(), 'memphis-darwin-lock-'));
  roots.push(dataDir);
  const first = acquireProcessLock({ dataDir });
  try {
    const path = lockPathFor(dataDir);
    const identity = JSON.parse(readFileSync(path, 'utf8'));
    expect(identity).toMatchObject({
      bootId: 'boot-session-A',
      startTime: Date.parse('Mon Oct 26 12:00:00 2026'),
    });
    expect(acquireProcessLock({ dataDir }).acquired).toBe(false);
    expect(peekProcessLock(dataDir).alive).toBe(true);
    writeFileSync(path, JSON.stringify({ ...identity, bootId: 'old-boot' }));
    expect(peekProcessLock(dataDir).alive).toBe(false);
    writeFileSync(path, JSON.stringify({ ...identity, startTime: identity.startTime - 1000 }));
    expect(peekProcessLock(dataDir).alive).toBe(false);
    expect(command).toHaveBeenCalledWith(
      '/bin/ps',
      ['-p', String(process.pid), '-o', 'lstart='],
      expect.objectContaining({ env: expect.objectContaining({ LC_ALL: 'C' }) }),
    );
  } finally {
    first.release();
  }
});
