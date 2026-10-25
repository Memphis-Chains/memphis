import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { append, rotate } = vi.hoisted(() => ({ append: vi.fn(), rotate: vi.fn() }));
vi.mock('node:fs', async (original) => ({
  ...(await original<typeof import('node:fs')>()),
  appendFileSync: append,
}));
vi.mock('../../src/infra/logging/audit-rotation.js', async (original) => ({
  ...(await original<typeof import('../../src/infra/logging/audit-rotation.js')>()),
  maybeRotateAuditLog: rotate,
}));

import { writeSecurityAudit } from '../../src/infra/logging/security-audit.js';

const sentinel = 'synthetic-private-audit-storage-context';
describe('security audit storage failure diagnostics', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });
  it.each(['ENOSPC', 'EACCES', 'synthetic-private-errno'])(
    'keeps write exception/context private for %s',
    (code) => {
      const stderr = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
      append.mockImplementation(() => {
        throw Object.assign(new Error(sentinel, { cause: { Authorization: sentinel } }), { code });
      });
      expect(() =>
        writeSecurityAudit(
          { action: sentinel, status: 'error' },
          { ...process.env, MEMPHIS_TEST_ALLOW_AUDIT_WRITE: '1' },
        ),
      ).not.toThrow();
      const observed = stderr.mock.calls.map(([s]) => String(s)).join('');
      expect(observed).not.toContain(sentinel);
      expect(observed).not.toContain('synthetic-private-errno');
      expect(observed).toContain(code === 'synthetic-private-errno' ? 'AUDIT_WRITE_FAILED' : code);
    },
  );
  it.each(['ENOSPC', 'EACCES', 'synthetic-private-errno'])(
    'keeps rotation exceptions private and continues recording for %s',
    (code) => {
      const stderr = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
      rotate.mockImplementation(() => {
        throw Object.assign(new Error(sentinel, { cause: { token: sentinel } }), { code });
      });
      expect(() =>
        writeSecurityAudit(
          { action: 'fixture.event', status: 'allowed' },
          { ...process.env, MEMPHIS_TEST_ALLOW_AUDIT_WRITE: '1' },
        ),
      ).not.toThrow();
      expect(append).toHaveBeenCalledOnce();
      const observed = stderr.mock.calls.map(([s]) => String(s)).join('');
      expect(observed).not.toContain(sentinel);
      expect(observed).not.toContain('synthetic-private-errno');
      expect(observed).toContain(code === 'synthetic-private-errno' ? 'AUDIT_WRITE_FAILED' : code);
    },
  );
  it('does not invoke an exception code getter while reporting a write failure', () => {
    const stderr = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    const getter = vi.fn(() => {
      throw new Error(sentinel);
    });
    const failure = Object.defineProperty(new Error(sentinel), 'code', { get: getter });
    append.mockImplementation(() => {
      throw failure;
    });
    expect(() =>
      writeSecurityAudit(
        { action: 'fixture.event', status: 'error' },
        { ...process.env, MEMPHIS_TEST_ALLOW_AUDIT_WRITE: '1' },
      ),
    ).not.toThrow();
    expect(getter).not.toHaveBeenCalled();
    expect(stderr.mock.calls.map(([s]) => String(s)).join('')).toContain('AUDIT_WRITE_FAILED');
    expect(stderr.mock.calls.map(([s]) => String(s)).join('')).not.toContain(sentinel);
  });

  it('contains an exception whose code descriptor inspection itself throws', () => {
    const stderr = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    const failure = new Proxy(new Error(sentinel), {
      getOwnPropertyDescriptor() {
        throw new Error(sentinel);
      },
    });
    append.mockImplementation(() => {
      throw failure;
    });
    expect(() =>
      writeSecurityAudit(
        { action: 'fixture.event', status: 'error' },
        { ...process.env, MEMPHIS_TEST_ALLOW_AUDIT_WRITE: '1' },
      ),
    ).not.toThrow();
    expect(stderr.mock.calls.map(([s]) => String(s)).join('')).toContain('AUDIT_WRITE_FAILED');
    expect(stderr.mock.calls.map(([s]) => String(s)).join('')).not.toContain(sentinel);
  });
});
