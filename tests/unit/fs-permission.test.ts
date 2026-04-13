/**
 * Unit tests for fs-permission (memphis_fs_write / memphis_fs_ops guard).
 *
 * Matrix:
 *   - Inside ~/memphis/ sandbox: all ops allowed regardless of tier
 *   - Outside sandbox, nonexistent target: create-new/copy-dest/move-dest/mkdir allowed
 *   - Outside sandbox, existing target: overwrite/append/delete denied at tier 2, allowed at tier 3
 *   - ALWAYS_BLOCKED paths (.env, vault-*, .git/, node_modules/): denied at every tier
 *   - stat: always allowed (except always-blocked)
 */
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import os, { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { AppError } from '../../src/core/errors.js';
import {
  assertFsPermission,
  isInsideMemphisSandbox,
  isTier3FsBypassActive,
  resolveFsPath,
  type FsPermissionOperation,
} from '../../src/mcp/tools/fs-permission.js';

let testDir: string;
let existingFile: string;
let nonexistentFile: string;
const sandboxRoot = join(os.homedir(), 'memphis');

function check(path: string, op: FsPermissionOperation, tier3Active = false): void {
  assertFsPermission(path, { operation: op, tier3Active });
}

function expectDenied(path: string, op: FsPermissionOperation, tier3Active = false): void {
  try {
    check(path, op, tier3Active);
    throw new Error(`expected assertFsPermission to throw for ${op} on ${path}`);
  } catch (err) {
    expect(err).toBeInstanceOf(AppError);
    if (err instanceof AppError) {
      expect(err.statusCode).toBe(403);
    }
  }
}

beforeEach(() => {
  testDir = join(
    tmpdir(),
    `memphis-fs-perm-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  mkdirSync(testDir, { recursive: true });
  existingFile = join(testDir, 'existing.txt');
  writeFileSync(existingFile, 'seed');
  nonexistentFile = join(testDir, 'does-not-exist.txt');
});

afterEach(() => {
  rmSync(testDir, { recursive: true, force: true });
});

describe('isInsideMemphisSandbox', () => {
  it('recognizes the sandbox root and subpaths', () => {
    expect(isInsideMemphisSandbox(sandboxRoot)).toBe(true);
    expect(isInsideMemphisSandbox(join(sandboxRoot, 'a', 'b', 'c.txt'))).toBe(true);
  });

  it('rejects paths outside the sandbox', () => {
    expect(isInsideMemphisSandbox('/tmp/something')).toBe(false);
    expect(isInsideMemphisSandbox('/etc/passwd')).toBe(false);
  });

  it('rejects sibling directories that merely share a prefix', () => {
    expect(isInsideMemphisSandbox(`${sandboxRoot}-evil`)).toBe(false);
    expect(isInsideMemphisSandbox(`${sandboxRoot}2`)).toBe(false);
  });
});

describe('resolveFsPath', () => {
  it('expands ~/ to the home directory', () => {
    expect(resolveFsPath('~/foo/bar')).toBe(join(os.homedir(), 'foo', 'bar'));
  });

  it('resolves relative paths against cwd', () => {
    const resolved = resolveFsPath('./relative');
    expect(resolved.startsWith('/')).toBe(true);
  });
});

describe('assertFsPermission — inside sandbox', () => {
  const inside = join(sandboxRoot, 'any', 'deep', 'path.txt');

  it.each<FsPermissionOperation>([
    'create-new',
    'append',
    'overwrite',
    'copy-dest',
    'move-dest',
    'delete',
    'mkdir',
    'stat',
  ])('allows %s inside the sandbox at tier 2', (op) => {
    expect(() => check(inside, op)).not.toThrow();
  });
});

describe('assertFsPermission — outside sandbox, additive operations', () => {
  it('allows create-new on a nonexistent target', () => {
    expect(() => check(nonexistentFile, 'create-new')).not.toThrow();
  });

  it('denies create-new on an existing target at tier 2', () => {
    expectDenied(existingFile, 'create-new');
  });

  it('allows copy-dest / move-dest on nonexistent targets', () => {
    expect(() => check(nonexistentFile, 'copy-dest')).not.toThrow();
    expect(() => check(nonexistentFile, 'move-dest')).not.toThrow();
  });

  it('denies copy-dest / move-dest on existing targets at tier 2', () => {
    expectDenied(existingFile, 'copy-dest');
    expectDenied(existingFile, 'move-dest');
  });

  it('allows mkdir outside sandbox (idempotent additive)', () => {
    expect(() => check(join(testDir, 'new-dir'), 'mkdir')).not.toThrow();
    expect(() => check(testDir, 'mkdir')).not.toThrow();
  });
});

describe('assertFsPermission — outside sandbox, destructive operations', () => {
  it('denies overwrite at tier 2', () => {
    expectDenied(existingFile, 'overwrite');
  });

  it('denies append at tier 2', () => {
    expectDenied(existingFile, 'append');
  });

  it('denies delete at tier 2', () => {
    expectDenied(existingFile, 'delete');
  });

  it('allows overwrite / append / delete when tier-3 is active', () => {
    expect(() => check(existingFile, 'overwrite', true)).not.toThrow();
    expect(() => check(existingFile, 'append', true)).not.toThrow();
    expect(() => check(existingFile, 'delete', true)).not.toThrow();
  });

  it('includes a clear tier-3 elevation hint in the denial message', () => {
    try {
      check(existingFile, 'overwrite');
      throw new Error('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(AppError);
      if (err instanceof AppError) {
        expect(err.message).toContain('/tier 3');
        expect(err.message).toContain(existingFile);
      }
    }
  });
});

describe('assertFsPermission — ALWAYS_BLOCKED patterns', () => {
  const base = '/tmp/memphis-fs-blocked-samples';
  const blockedSamples: Array<[string, string]> = [
    ['.env in cwd', join(base, '.env')],
    ['.env.local', join(base, '.env.local')],
    ['.env.production', join(base, 'nested', '.env.production')],
    ['vault-state.json', join(base, 'vault-state.json')],
    ['vault-entries.json', join(base, 'some', 'path', 'vault-entries.json')],
    ['.git directory itself', join(base, '.git')],
    ['file inside .git', join(base, '.git', 'HEAD')],
    ['file inside node_modules', join(base, 'node_modules', 'pkg', 'index.js')],
  ];

  it.each(blockedSamples)('blocks %s at tier 2 (overwrite)', (_label, p) => {
    expectDenied(p, 'overwrite');
  });

  it.each(blockedSamples)('blocks %s at tier 3 too (overwrite)', (_label, p) => {
    expectDenied(p, 'overwrite', true);
  });

  it.each(blockedSamples)('blocks %s even for create-new at tier 2', (_label, p) => {
    expectDenied(p, 'create-new');
  });

  it('blocks .env inside the sandbox too', () => {
    expectDenied(join(sandboxRoot, '.env'), 'overwrite');
  });

  it('blocks .git/ inside the sandbox too', () => {
    expectDenied(join(sandboxRoot, '.git', 'HEAD'), 'delete');
  });

  it('blocks even stat on an always-blocked path', () => {
    expectDenied(join(base, '.env'), 'stat');
  });
});

describe('assertFsPermission — stat', () => {
  it('is allowed outside sandbox on nonexistent paths', () => {
    expect(() => check(nonexistentFile, 'stat')).not.toThrow();
  });

  it('is allowed outside sandbox on existing paths', () => {
    expect(() => check(existingFile, 'stat')).not.toThrow();
  });
});

describe('isTier3FsBypassActive', () => {
  it('returns true when MEMPHIS_TIER3_FS_UNRESTRICTED=true', () => {
    expect(isTier3FsBypassActive({ MEMPHIS_TIER3_FS_UNRESTRICTED: 'true' })).toBe(true);
  });

  it('is case-insensitive on the value', () => {
    expect(isTier3FsBypassActive({ MEMPHIS_TIER3_FS_UNRESTRICTED: 'TRUE' })).toBe(true);
  });

  it('returns false when the env var is unset or not "true"', () => {
    expect(isTier3FsBypassActive({})).toBe(false);
    expect(isTier3FsBypassActive({ MEMPHIS_TIER3_FS_UNRESTRICTED: 'false' })).toBe(false);
    expect(isTier3FsBypassActive({ MEMPHIS_TIER3_FS_UNRESTRICTED: '1' })).toBe(false);
  });
});
