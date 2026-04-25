import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  statSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';

import { describe, expect, it } from 'vitest';

import {
  logRotationDisabled,
  maybeRotateLogFile,
  resolveLogKeepArchives,
  resolveLogRotateBytes,
} from '../../src/infra/logging/log-rotation.js';

function fixture(): { dir: string; logPath: string; archiveDir: string } {
  const dir = mkdtempSync(join(tmpdir(), 'mv4-log-rot-'));
  const logPath = join(dir, 'memphis.log');
  const archiveDir = join(dir, 'archives');
  return { dir, logPath, archiveDir };
}

function smallThresholdEnv(): NodeJS.ProcessEnv {
  return { MEMPHIS_LOG_ROTATE_BYTES: String(64 * 1024) } as NodeJS.ProcessEnv;
}

describe('maybeRotateLogFile', () => {
  it('is a no-op when the log file does not exist', () => {
    const { logPath } = fixture();
    const result = maybeRotateLogFile(logPath, smallThresholdEnv());
    expect(result.rotated).toBe(false);
  });

  it('is a no-op when the log is below threshold', () => {
    const { logPath } = fixture();
    writeFileSync(logPath, 'tiny\n');
    const result = maybeRotateLogFile(logPath, smallThresholdEnv());
    expect(result.rotated).toBe(false);
  });

  it('rotates a log over threshold and writes a .gz archive', () => {
    const { logPath, archiveDir } = fixture();
    const line = `${JSON.stringify({ level: 30, msg: 'x' })}\n`;
    const bigContent = line.repeat(3000);
    writeFileSync(logPath, bigContent);
    expect(statSync(logPath).size).toBeGreaterThan(64 * 1024);

    const result = maybeRotateLogFile(logPath, smallThresholdEnv());
    expect(result.rotated).toBe(true);
    expect(result.archivePath).toBeDefined();
    expect(result.archivePath!.endsWith('.gz')).toBe(true);
    expect(existsSync(result.archivePath!)).toBe(true);

    const archives = readdirSync(archiveDir).filter((n) => n.endsWith('.gz'));
    expect(archives.length).toBe(1);
    expect(archives[0]!.startsWith('memphis-')).toBe(true);

    const decompressed = gunzipSync(readFileSync(result.archivePath!)).toString('utf8');
    expect(decompressed).toBe(bigContent);

    expect(existsSync(logPath)).toBe(true);
    expect(readFileSync(logPath, 'utf8')).toBe('');
  });

  it('prunes old archives keeping only N newest', () => {
    const { logPath, archiveDir } = fixture();
    mkdirSync(archiveDir, { recursive: true });
    const now = Date.now();
    for (let i = 0; i < 5; i += 1) {
      const p = join(archiveDir, `memphis-old-${i}.gz`);
      writeFileSync(p, Buffer.from([0x1f, 0x8b, 0x08]));
      const t = (now - (5 - i) * 60_000) / 1000;
      utimesSync(p, t, t);
    }

    const line = `${JSON.stringify({ level: 30, msg: 'x' })}\n`;
    writeFileSync(logPath, line.repeat(3000));

    const env = {
      ...smallThresholdEnv(),
      MEMPHIS_LOG_ROTATE_KEEP: '2',
    } as NodeJS.ProcessEnv;
    const result = maybeRotateLogFile(logPath, env);
    expect(result.rotated).toBe(true);
    expect(result.prunedArchives).toBeGreaterThanOrEqual(4);

    const remaining = readdirSync(archiveDir).filter((n) => n.endsWith('.gz'));
    expect(remaining.length).toBe(2);
  });

  it('skips rotation when MEMPHIS_LOG_ROTATE=disabled', () => {
    const { logPath } = fixture();
    const line = `${JSON.stringify({ level: 30, msg: 'x' })}\n`;
    writeFileSync(logPath, line.repeat(3000));
    const env = {
      ...smallThresholdEnv(),
      MEMPHIS_LOG_ROTATE: 'disabled',
    } as NodeJS.ProcessEnv;
    const result = maybeRotateLogFile(logPath, env);
    expect(result.rotated).toBe(false);
    expect(statSync(logPath).size).toBeGreaterThan(64 * 1024);
  });

  it('clamps rotate-bytes and keep-archives to allowed ranges', () => {
    expect(
      resolveLogRotateBytes({ MEMPHIS_LOG_ROTATE_BYTES: '1' } as NodeJS.ProcessEnv),
    ).toBe(64 * 1024);
    expect(
      resolveLogRotateBytes({
        MEMPHIS_LOG_ROTATE_BYTES: String(10 * 1024 * 1024 * 1024),
      } as NodeJS.ProcessEnv),
    ).toBe(100 * 1024 * 1024);
    expect(resolveLogKeepArchives({ MEMPHIS_LOG_ROTATE_KEEP: '0' } as NodeJS.ProcessEnv)).toBe(1);
    expect(
      resolveLogKeepArchives({ MEMPHIS_LOG_ROTATE_KEEP: '500' } as NodeJS.ProcessEnv),
    ).toBe(100);
  });

  it('leaves the log untouched when the archive dir cannot be created', () => {
    const { dir, logPath, archiveDir } = fixture();
    // Plant a regular file at the exact path mkdirSync would use for the
    // archive dir; mkdirSync(..., {recursive:true}) raises ENOTDIR and the
    // rotation must bail out cleanly without renaming the live log.
    writeFileSync(archiveDir, 'not-a-dir');

    const line = `${JSON.stringify({ level: 30, msg: 'x' })}\n`;
    const original = line.repeat(3000);
    writeFileSync(logPath, original);

    const result = maybeRotateLogFile(logPath, smallThresholdEnv());
    expect(result.rotated).toBe(false);
    expect(existsSync(logPath)).toBe(true);
    expect(readFileSync(logPath, 'utf8')).toBe(original);
    // archiveDir blocker still in place — nothing materialized
    expect(statSync(archiveDir).isFile()).toBe(true);
    void dir;
  });

  it('logRotationDisabled accepts disabled/off/false/0', () => {
    for (const v of ['disabled', 'off', 'false', '0', 'DISABLED', 'Off']) {
      expect(logRotationDisabled({ MEMPHIS_LOG_ROTATE: v } as NodeJS.ProcessEnv)).toBe(true);
    }
    for (const v of ['enabled', 'on', '1', '', undefined]) {
      expect(
        logRotationDisabled({ MEMPHIS_LOG_ROTATE: v as string } as NodeJS.ProcessEnv),
      ).toBe(false);
    }
  });
});
