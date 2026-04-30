import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  __resetSensitiveFileHealCacheForTests,
  healSensitiveFilePerms,
  writeSensitiveFile,
} from '../../src/infra/storage/secure-file.js';
import { realTmpdir } from '../helpers/tmpdir.js';

describe('writeSensitiveFile', () => {
  let dir: string;

  beforeEach(() => {
    __resetSensitiveFileHealCacheForTests();
    dir = mkdtempSync(join(realTmpdir(), 'memphis-secure-file-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('writes the payload at mode 0o600', () => {
    const target = join(dir, 'sensitive.json');
    writeSensitiveFile(target, '{"k":"v"}');
    expect(readFileSync(target, 'utf8')).toBe('{"k":"v"}');
    const mode = statSync(target).mode & 0o777;
    expect(mode).toBe(0o600);
  });

  it('creates the parent directory with 0o700 when missing', () => {
    const nested = join(dir, 'nested', 'sub', 'file.json');
    writeSensitiveFile(nested, '{}');
    expect(existsSync(nested)).toBe(true);
    const parentMode = statSync(join(dir, 'nested')).mode & 0o777;
    // mkdirSync with mode applies after umask — we accept anything that
    // doesn't grant group/world bits beyond what we set.
    expect(parentMode & 0o077).toBe(0);
  });

  it('overwrites a pre-existing wider-permissions file with 0o600', () => {
    const target = join(dir, 'old.json');
    writeFileSync(target, '{"old":true}');
    chmodSync(target, 0o644);
    expect(statSync(target).mode & 0o777).toBe(0o644);
    writeSensitiveFile(target, '{"new":true}');
    expect(statSync(target).mode & 0o777).toBe(0o600);
    expect(readFileSync(target, 'utf8')).toBe('{"new":true}');
  });
});

describe('healSensitiveFilePerms', () => {
  let dir: string;

  beforeEach(() => {
    __resetSensitiveFileHealCacheForTests();
    dir = mkdtempSync(join(realTmpdir(), 'memphis-secure-heal-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('returns "absent" when the file does not exist', () => {
    expect(healSensitiveFilePerms(join(dir, 'no.json'))).toBe('absent');
  });

  it('returns "ok" when the file already has 0o600', () => {
    const target = join(dir, 'tight.json');
    writeFileSync(target, '{}', { mode: 0o600 });
    chmodSync(target, 0o600);
    expect(healSensitiveFilePerms(target)).toBe('ok');
    expect(statSync(target).mode & 0o777).toBe(0o600);
  });

  it('returns "healed" and tightens to 0o600 when wider', () => {
    const target = join(dir, 'wide.json');
    writeFileSync(target, '{}');
    chmodSync(target, 0o644);
    expect(healSensitiveFilePerms(target)).toBe('healed');
    expect(statSync(target).mode & 0o777).toBe(0o600);
  });

  it('only acts once per process per path (idempotent)', () => {
    const target = join(dir, 'once.json');
    writeFileSync(target, '{}');
    chmodSync(target, 0o644);
    expect(healSensitiveFilePerms(target)).toBe('healed');
    // Manually loosen again — heal is cached, should NOT chmod again
    chmodSync(target, 0o644);
    expect(healSensitiveFilePerms(target)).toBe('ok');
    // Cache short-circuits before stat, so the loose perms persist —
    // that is the contract: heal is best-effort one-time per process.
    expect(statSync(target).mode & 0o777).toBe(0o644);
  });

  it('emits a stderr warning when healing', () => {
    const target = join(dir, 'warn.json');
    writeFileSync(target, '{}');
    chmodSync(target, 0o644);
    const warns: string[] = [];
    const original = process.stderr.write;
    process.stderr.write = ((chunk: string | Uint8Array) => {
      warns.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString());
      return true;
    }) as typeof process.stderr.write;
    try {
      healSensitiveFilePerms(target);
    } finally {
      process.stderr.write = original;
    }
    expect(warns.some((w) => w.includes('tightened perms'))).toBe(true);
  });
});
