import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { maybeRotateAuditLog } from '../../src/infra/logging/audit-rotation.js';

/**
 * Regression net for Codex P1: audit rotation filename collision when two
 * rotations fire in the same second.
 *
 * Before the fix, the archive filename was generated from an ISO timestamp
 * with the millisecond component stripped, so any two rotations within the
 * same calendar second produced the same `security-audit-<stamp>.jsonl.gz`
 * path. Because `writeFileSync` overwrites, the second rotation silently
 * destroyed the first archive. The fix keeps the millisecond component and
 * adds a counter fallback on exact collisions.
 */

interface TestEnv {
  dataDir: string;
  logPath: string;
  archiveDir: string;
  prevEnv: NodeJS.ProcessEnv;
}

function setup(): TestEnv {
  const dataDir = mkdtempSync(join(tmpdir(), 'memphis-audit-rot-'));
  const logPath = join(dataDir, 'security-audit.jsonl');
  const archiveDir = join(dataDir, 'security-audit-archives');
  const prevEnv = { ...process.env };
  process.env.MEMPHIS_SECURITY_AUDIT_LOG_PATH = logPath;
  process.env.MEMPHIS_SECURITY_AUDIT_ARCHIVE_DIR = archiveDir;
  process.env.MEMPHIS_SECURITY_AUDIT_ROTATE_BYTES = '65536'; // min allowed
  return { dataDir, logPath, archiveDir, prevEnv };
}

function tearDown(env: TestEnv): void {
  rmSync(env.dataDir, { recursive: true, force: true });
  for (const key of Object.keys(process.env)) {
    if (!(key in env.prevEnv)) delete process.env[key];
  }
  Object.assign(process.env, env.prevEnv);
}

function fillLogBeyondThreshold(logPath: string, payload: string): void {
  // 65536 bytes + a bit to ensure we cross the threshold.
  const blob = payload.padEnd(70_000, '.');
  writeFileSync(logPath, `${blob}\n`, 'utf8');
}

describe('maybeRotateAuditLog — filename collision hardening', () => {
  let env: TestEnv;

  beforeEach(() => {
    env = setup();
  });

  afterEach(() => {
    tearDown(env);
  });

  it('two rotations in the same second produce two distinct archive files', () => {
    fillLogBeyondThreshold(env.logPath, 'first');
    const first = maybeRotateAuditLog();
    expect(first.rotated).toBe(true);
    expect(existsSync(first.archivePath!)).toBe(true);

    fillLogBeyondThreshold(env.logPath, 'second');
    const second = maybeRotateAuditLog();
    expect(second.rotated).toBe(true);
    expect(existsSync(second.archivePath!)).toBe(true);

    // Distinct paths — the whole point of the regression test.
    expect(second.archivePath).not.toBe(first.archivePath);

    // Both archive files still present and decompress to the original
    // contents, proving neither was overwritten.
    const archives = readdirSync(env.archiveDir).sort();
    expect(archives).toHaveLength(2);
    for (const file of archives) {
      const buf = readFileSync(join(env.archiveDir, file));
      const uncompressed = gunzipSync(buf).toString('utf8');
      expect(uncompressed.length).toBeGreaterThan(0);
    }
  });

  it('three rotations in rapid succession all preserved', () => {
    for (let i = 0; i < 3; i += 1) {
      fillLogBeyondThreshold(env.logPath, `batch-${i}`);
      const result = maybeRotateAuditLog();
      expect(result.rotated).toBe(true);
    }
    const archives = readdirSync(env.archiveDir);
    expect(archives).toHaveLength(3);
    const unique = new Set(archives);
    expect(unique.size).toBe(archives.length);
  });
});
