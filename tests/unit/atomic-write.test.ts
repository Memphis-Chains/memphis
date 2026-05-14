/**
 * Atomic write helper — symlink defense + O_EXCL + fsync + rename.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  atomicWriteJsonSync,
  atomicWriteSync,
} from '../../src/infra/runtime/atomic-write.js';

describe('atomicWriteSync', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'atomic-write-test-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('writes data and finalises at the canonical path', () => {
    const filePath = path.join(tmpDir, 'state.txt');
    atomicWriteSync(filePath, 'hello');
    expect(fs.readFileSync(filePath, 'utf8')).toBe('hello');
    expect(fs.statSync(filePath).mode & 0o777).toBe(0o600);
  });

  it('creates the parent directory with restricted mode when missing', () => {
    const nested = path.join(tmpDir, 'a', 'b', 'state.txt');
    atomicWriteSync(nested, 'x');
    const dirMode = fs.statSync(path.dirname(nested)).mode & 0o777;
    expect(dirMode).toBe(0o700);
  });

  it('overwrites an existing canonical file atomically', () => {
    const filePath = path.join(tmpDir, 'state.txt');
    atomicWriteSync(filePath, 'first');
    atomicWriteSync(filePath, 'second');
    expect(fs.readFileSync(filePath, 'utf8')).toBe('second');
    expect(fs.existsSync(filePath + '.tmp')).toBe(false);
  });

  it('removes a stale tmp file from a prior crashed write', () => {
    const filePath = path.join(tmpDir, 'state.txt');
    // Simulate a torn write leaving a tmp file behind from a crashed
    // process. Atomic write must clear it before opening O_EXCL.
    fs.writeFileSync(filePath + '.tmp', 'stale');
    atomicWriteSync(filePath, 'fresh');
    expect(fs.readFileSync(filePath, 'utf8')).toBe('fresh');
  });

  it('refuses to follow a symlinked tmp path (symlink defense)', () => {
    // Same-uid attacker pre-plants `<file>.tmp` as a symlink to a
    // sensitive file. Without the defense, the O_EXCL open would
    // resolve the symlink and clobber the target via writeSync.
    const filePath = path.join(tmpDir, 'state.txt');
    const sensitive = path.join(tmpDir, 'sensitive.txt');
    fs.writeFileSync(sensitive, 'do-not-overwrite');
    fs.symlinkSync(sensitive, filePath + '.tmp');

    atomicWriteSync(filePath, 'safe');

    expect(fs.readFileSync(sensitive, 'utf8')).toBe('do-not-overwrite');
    expect(fs.readFileSync(filePath, 'utf8')).toBe('safe');
  });

  it('honours custom fileMode option', () => {
    const filePath = path.join(tmpDir, 'state.txt');
    atomicWriteSync(filePath, 'x', { fileMode: 0o640 });
    expect(fs.statSync(filePath).mode & 0o777).toBe(0o640);
  });
});

describe('atomicWriteJsonSync', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'atomic-write-json-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('roundtrips a JSON object via disk', () => {
    const filePath = path.join(tmpDir, 'state.json');
    const value = { surface: 'tui', actorId: 'local', tier: 3, expiresAt: 123 };
    atomicWriteJsonSync(filePath, value);
    expect(JSON.parse(fs.readFileSync(filePath, 'utf8'))).toEqual(value);
  });

  it('uses 2-space indent for human-readable state files', () => {
    const filePath = path.join(tmpDir, 'state.json');
    atomicWriteJsonSync(filePath, { a: 1 });
    expect(fs.readFileSync(filePath, 'utf8')).toBe('{\n  "a": 1\n}');
  });
});
