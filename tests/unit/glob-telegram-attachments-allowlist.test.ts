/**
 * The read scope of `memphis_glob`.
 *
 * Background (REV2 Temat 1, 2026-05-12): the operator's Telegram session
 * hit `memphis_glob` returning 'Path outside ~/memphis/' when the agent
 * tried to look for a forwarded photo attachment. The fix at the time was
 * to add one more root to the allowlist.
 *
 * The allowlist is gone now: the scope is the TIER (2, vault passphrase),
 * not a list of directories — `memphis_exec` at the same tier could
 * `find` any directory anyway. So the attachment directory needs no
 * special case any more, and neither does any other directory.
 *
 * What is still refused is vault material, because the file list is
 * indexed.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { buildFdArgs, runMemphisGlob } from '../../src/mcp/tools/glob.js';

describe('memphis_glob — the read scope is the tier, not a directory allowlist', () => {
  let dataDir: string;
  let prevDataDir: string | undefined;

  beforeEach(() => {
    dataDir = mkdtempSync(path.join(os.tmpdir(), 'memphis-glob-attach-'));
    prevDataDir = process.env.MEMPHIS_DATA_DIR;
    process.env.MEMPHIS_DATA_DIR = dataDir;
  });

  afterEach(() => {
    if (prevDataDir !== undefined) process.env.MEMPHIS_DATA_DIR = prevDataDir;
    else delete process.env.MEMPHIS_DATA_DIR;
    rmSync(dataDir, { recursive: true, force: true });
  });

  it('globs inside the MEMPHIS_DATA_DIR/state/telegram-attachments/ root', () => {
    const attachDir = path.join(dataDir, 'state', 'telegram-attachments');
    mkdirSync(attachDir, { recursive: true });
    writeFileSync(path.join(attachDir, 'tg-photo-1-2026.jpg'), 'fake-bytes');

    const result = runMemphisGlob({ pattern: 'tg-photo-*.jpg', path: attachDir });
    expect(result.error).toBeUndefined();
    expect(result.files.length).toBeGreaterThan(0);
    expect(result.files[0]).toContain('tg-photo-1-2026.jpg');
  });

  it('globs a directory outside ~/memphis, because the host is readable', () => {
    const tmpProbe = mkdtempSync(path.join(os.tmpdir(), 'memphis-glob-tmp-probe-'));
    try {
      writeFileSync(path.join(tmpProbe, 'leak.txt'), 'x');
      const result = runMemphisGlob({ pattern: '*.txt', path: tmpProbe });
      expect(result.error).toBeUndefined();
      expect(result.files.length).toBeGreaterThan(0);
    } finally {
      rmSync(tmpProbe, { recursive: true, force: true });
    }
  });

  it('narrows back down when MEMPHIS_CODE_READ_ROOTS is set', () => {
    const tmpProbe = mkdtempSync(path.join(os.tmpdir(), 'memphis-glob-narrowed-'));
    const prevRoots = process.env.MEMPHIS_CODE_READ_ROOTS;
    try {
      writeFileSync(path.join(tmpProbe, 'leak.txt'), 'x');
      process.env.MEMPHIS_CODE_READ_ROOTS = path.join(dataDir, 'state');
      expect(() => runMemphisGlob({ pattern: '*.txt', path: tmpProbe })).toThrow(
        /outside the allowed read roots/,
      );
    } finally {
      if (prevRoots === undefined) delete process.env.MEMPHIS_CODE_READ_ROOTS;
      else process.env.MEMPHIS_CODE_READ_ROOTS = prevRoots;
      rmSync(tmpProbe, { recursive: true, force: true });
    }
  });

  it('refuses to glob vault material, because the file list is indexed', () => {
    const vaultProbe = mkdtempSync(path.join(os.tmpdir(), 'memphis-glob-vault-'));
    try {
      const target = path.join(vaultProbe, '.env');
      writeFileSync(target, 'SECRET=1');
      expect(() => runMemphisGlob({ pattern: '*', path: target })).toThrow(/blocked/i);
    } finally {
      rmSync(vaultProbe, { recursive: true, force: true });
    }
  });

  it('excludes vault material from the fd invocation', () => {
    // The argument builder is a pure function, so this rule is tested even
    // on a host where `fd` is not installed — which is the case here, and
    // the reason the exclusion had no test at all.
    const args = buildFdArgs('*', '/tmp/probe', 100);
    expect(args).toContain('!.env');
    expect(args).toContain('!.env.*');
    expect(args).toContain('!vault-state.json');
    expect(args).toContain('!vault-entries.json');
  });

  it('does not list a vault-material file inside a listed directory', () => {
    const vaultProbe = mkdtempSync(path.join(os.tmpdir(), 'memphis-glob-vault-dir-'));
    try {
      writeFileSync(path.join(vaultProbe, '.env'), 'SECRET=1');
      writeFileSync(path.join(vaultProbe, '.env.production'), 'SECRET=2');
      writeFileSync(path.join(vaultProbe, 'vault-state.json'), '{}');
      writeFileSync(path.join(vaultProbe, 'vault-entries.json'), '{}');
      writeFileSync(path.join(vaultProbe, 'ordinary.txt'), 'x');

      const result = runMemphisGlob({ pattern: '*', path: vaultProbe });

      expect(result.error).toBeUndefined();
      expect(result.files.join('\n')).toContain('ordinary.txt');
      expect(result.files.join('\n')).not.toContain('.env');
      expect(result.files.join('\n')).not.toContain('vault-state.json');
      expect(result.files.join('\n')).not.toContain('vault-entries.json');
    } finally {
      rmSync(vaultProbe, { recursive: true, force: true });
    }
  });
});
