import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';

import { describe, expect, it } from 'vitest';

import { searchAuditLog } from '../../src/infra/logging/audit-search.js';

function makeLine(
  ts: string,
  action: string,
  status: string,
  extra: Record<string, unknown> = {},
): string {
  return `${JSON.stringify({ ts, action, status, ...extra })}\n`;
}

function fixture(): { env: NodeJS.ProcessEnv; logPath: string; archiveDir: string } {
  const dir = mkdtempSync(join(tmpdir(), 'mv4-audit-search-'));
  const logPath = join(dir, 'security-audit.jsonl');
  const archiveDir = join(dir, 'security-audit-archives');
  mkdirSync(archiveDir, { recursive: true });
  const env = {
    MEMPHIS_SECURITY_AUDIT_LOG_PATH: logPath,
    MEMPHIS_SECURITY_AUDIT_ARCHIVE_DIR: archiveDir,
  } as NodeJS.ProcessEnv;
  return { env, logPath, archiveDir };
}

describe('searchAuditLog', () => {
  it('returns records from the current log, newest-first', async () => {
    const { env, logPath } = fixture();
    writeFileSync(
      logPath,
      makeLine('2026-04-13T10:00:00Z', 'vault.secret-store', 'allowed') +
        makeLine('2026-04-13T11:00:00Z', 'vault.secret-delete', 'allowed'),
    );

    const result = await searchAuditLog({}, env);
    expect(result.records.length).toBe(2);
    expect(result.records[0].action).toBe('vault.secret-delete');
    expect(result.records[1].action).toBe('vault.secret-store');
    expect(result.truncated).toBe(false);
  });

  it('filters by action prefix and status', async () => {
    const { env, logPath } = fixture();
    writeFileSync(
      logPath,
      makeLine('2026-04-13T10:00:00Z', 'vault.secret-store', 'allowed') +
        makeLine('2026-04-13T10:05:00Z', 'provider.key-conflict', 'blocked') +
        makeLine('2026-04-13T10:10:00Z', 'vault.pepper-rotate', 'error'),
    );

    const byAction = await searchAuditLog({ action: 'vault.' }, env);
    expect(byAction.records.map((r) => r.action).sort()).toEqual([
      'vault.pepper-rotate',
      'vault.secret-store',
    ]);

    const byStatus = await searchAuditLog({ status: 'blocked' }, env);
    expect(byStatus.records).toHaveLength(1);
    expect(byStatus.records[0].action).toBe('provider.key-conflict');
  });

  it('searches archived .jsonl.gz files when criteria exceed the current log', async () => {
    const { env, logPath, archiveDir } = fixture();
    writeFileSync(logPath, makeLine('2026-04-13T12:00:00Z', 'cli.run', 'allowed'));

    const archiveLines =
      makeLine('2026-04-10T09:00:00Z', 'vault.init', 'allowed', { did: 'did:memphis:z6Mk' }) +
      makeLine('2026-04-10T09:01:00Z', 'vault.secret-store', 'allowed', {
        key: 'anthropic_api_key',
      });
    writeFileSync(
      join(archiveDir, 'security-audit-2026-04-10T09-05-00Z.jsonl.gz'),
      gzipSync(Buffer.from(archiveLines)),
    );

    const result = await searchAuditLog({ action: 'vault.' }, env);
    expect(result.records.length).toBe(2);
    expect(result.records.map((r) => r.action).sort()).toEqual([
      'vault.init',
      'vault.secret-store',
    ]);
    expect(result.filesScanned.length).toBe(2);
  });

  it('respects the limit and marks truncated', async () => {
    const { env, logPath } = fixture();
    const many = Array.from({ length: 50 }, (_, i) =>
      makeLine(`2026-04-13T10:${String(i).padStart(2, '0')}:00Z`, 'x', 'allowed'),
    ).join('');
    writeFileSync(logPath, many);

    const result = await searchAuditLog({ limit: 10 }, env);
    expect(result.records.length).toBe(10);
    expect(result.truncated).toBe(true);
  });

  it('matches "contains" case-insensitively against the raw line', async () => {
    const { env, logPath } = fixture();
    writeFileSync(
      logPath,
      makeLine('2026-04-13T10:00:00Z', 'vault.secret-store', 'allowed', { key: 'ANTHROPIC_KEY' }) +
        makeLine('2026-04-13T10:01:00Z', 'vault.secret-store', 'allowed', { key: 'minimax_key' }),
    );

    const result = await searchAuditLog({ contains: 'anthropic' }, env);
    expect(result.records.length).toBe(1);
  });
});
