import { existsSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';

import { describe, expect, it } from 'vitest';

import {
  maybeRotateAuditLog,
  resolveAuditArchiveDir,
  resolveAuditLogPath,
  resolveRotateThresholdBytes,
} from '../../src/infra/logging/audit-rotation.js';

function fixtureEnv(): { env: NodeJS.ProcessEnv; logPath: string; archiveDir: string } {
  const dir = mkdtempSync(join(tmpdir(), 'mv4-audit-rot-'));
  const logPath = join(dir, 'security-audit.jsonl');
  const archiveDir = join(dir, 'security-audit-archives');
  const env = {
    MEMPHIS_SECURITY_AUDIT_LOG_PATH: logPath,
    MEMPHIS_SECURITY_AUDIT_ARCHIVE_DIR: archiveDir,
    MEMPHIS_SECURITY_AUDIT_ROTATE_BYTES: String(64 * 1024),
  } as NodeJS.ProcessEnv;
  return { env, logPath, archiveDir };
}

describe('maybeRotateAuditLog', () => {
  it('is a no-op when the log file does not exist', () => {
    const { env } = fixtureEnv();
    const result = maybeRotateAuditLog(env);
    expect(result.rotated).toBe(false);
  });

  it('is a no-op when the log is below threshold', () => {
    const { env, logPath } = fixtureEnv();
    writeFileSync(logPath, 'a\n');
    const result = maybeRotateAuditLog(env);
    expect(result.rotated).toBe(false);
  });

  it('rotates when the log is at or above threshold, creating a .jsonl.gz archive', () => {
    const { env, logPath, archiveDir } = fixtureEnv();
    const line = JSON.stringify({ ts: new Date().toISOString(), action: 'x', status: 'allowed' });
    const bigContent = `${line}\n`.repeat(2000);
    writeFileSync(logPath, bigContent);

    expect(statSync(logPath).size).toBeGreaterThanOrEqual(resolveRotateThresholdBytes(env));

    const result = maybeRotateAuditLog(env);
    expect(result.rotated).toBe(true);
    expect(result.archivePath).toBeDefined();
    expect(result.archivePath!.endsWith('.jsonl.gz')).toBe(true);
    expect(existsSync(result.archivePath!)).toBe(true);

    const archives = readdirSync(archiveDir).filter((f) => f.endsWith('.jsonl.gz'));
    expect(archives.length).toBe(1);

    const decompressed = gunzipSync(readFileSync(result.archivePath!)).toString('utf8');
    expect(decompressed).toBe(bigContent);

    expect(existsSync(logPath)).toBe(true);
    expect(readFileSync(logPath, 'utf8')).toBe('');
  });

  it('clamps thresholds to the allowed range', () => {
    const tiny = resolveRotateThresholdBytes({
      MEMPHIS_SECURITY_AUDIT_ROTATE_BYTES: '1',
    } as NodeJS.ProcessEnv);
    expect(tiny).toBe(64 * 1024);

    const huge = resolveRotateThresholdBytes({
      MEMPHIS_SECURITY_AUDIT_ROTATE_BYTES: String(999 * 1024 * 1024),
    } as NodeJS.ProcessEnv);
    expect(huge).toBe(100 * 1024 * 1024);
  });

  it('honors path overrides', () => {
    const { env, logPath, archiveDir } = fixtureEnv();
    expect(resolveAuditLogPath(env)).toBe(logPath);
    expect(resolveAuditArchiveDir(env)).toBe(archiveDir);
  });
});
