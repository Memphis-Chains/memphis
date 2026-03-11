import { mkdirSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { resolveSafeChildPath } from '../../src/infra/http/path-validation.js';

describe('security: /api/journal path traversal', () => {
  it('rejects traversal and absolute path attempts', () => {
    const base = tmpdir();
    expect(() => resolveSafeChildPath(base, '../etc/passwd')).toThrow(/invalid path/);
    expect(() => resolveSafeChildPath(base, '/etc/passwd')).toThrow(/invalid path/);
    expect(() => resolveSafeChildPath(base, '..\\windows')).toThrow(/invalid path/);
  });

  it('rejects symlink targets', () => {
    const base = join(tmpdir(), `memphis-safe-path-${Date.now()}`);
    mkdirSync(base, { recursive: true });
    const evil = join(base, 'evil');
    symlinkSync('/tmp', evil);

    expect(() => resolveSafeChildPath(base, 'evil')).toThrow(/invalid path/);
  });

  it('accepts valid chain child path', () => {
    const base = join(tmpdir(), `memphis-safe-path-ok-${Date.now()}`);
    mkdirSync(base, { recursive: true });
    expect(resolveSafeChildPath(base, 'journal')).toContain('journal');
  });
});
