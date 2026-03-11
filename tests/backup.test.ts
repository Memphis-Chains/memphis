import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';

import { describe, expect, it } from 'vitest';

import {
  cleanBackups,
  createBackup,
  listBackups,
  restoreBackup,
  verifyBackup,
} from '../src/infra/cli/commands/backup.js';

describe('backup full workflow', () => {
  it('creates/list/verifies/restores/cleans backups using a mocked temp filesystem', async () => {
    const root = mkdtempSync(join(tmpdir(), 'memphis-backup-unit-'));
    const memphisRoot = join(root, '.memphis');
    const backupRoot = join(memphisRoot, 'backups');

    mkdirSync(join(memphisRoot, 'chains'), { recursive: true });
    mkdirSync(join(memphisRoot, 'embeddings'), { recursive: true });
    mkdirSync(join(memphisRoot, 'vault'), { recursive: true });
    mkdirSync(join(memphisRoot, 'config'), { recursive: true });
    mkdirSync(join(memphisRoot, 'cache'), { recursive: true });
    mkdirSync(join(memphisRoot, 'logs'), { recursive: true });

    writeFileSync(join(memphisRoot, 'chains', 'chain.txt'), 'v1', 'utf8');
    writeFileSync(join(memphisRoot, 'embeddings', 'index.json'), '{"v":1}', 'utf8');
    writeFileSync(join(memphisRoot, 'vault', 'secrets.json'), '{"key":"x"}', 'utf8');
    writeFileSync(join(memphisRoot, 'config', 'settings.json'), '{"mode":"test"}', 'utf8');
    writeFileSync(join(memphisRoot, 'cache', 'volatile.tmp'), 'skip-me', 'utf8');
    writeFileSync(join(memphisRoot, 'logs', 'app.log'), 'skip-me', 'utf8');
    writeFileSync(join(memphisRoot, 'runtime.lock'), 'skip-me', 'utf8');

    const created = await createBackup({ memphisRoot, backupRoot, tag: 'pre-update' });
    expect(created.file).toContain('pre-update-');
    expect(created.checksum.startsWith('sha256:')).toBe(true);

    const listed = await listBackups({ memphisRoot, backupRoot });
    expect(listed.backups.length).toBe(1);
    expect(listed.totalSize).toBeGreaterThan(0);

    const verified = await verifyBackup({ file: created.file, memphisRoot, backupRoot });
    expect(verified.valid).toBe(true);
    expect(verified.fileCount).toBeGreaterThan(0);

    writeFileSync(join(memphisRoot, 'chains', 'chain.txt'), 'corrupted', 'utf8');

    const restored = await restoreBackup({
      file: created.file,
      memphisRoot,
      backupRoot,
      confirm: true,
    });
    expect(restored.ok).toBe(true);
    const restoredChain = readFileSync(join(memphisRoot, 'chains', 'chain.txt'), 'utf8');
    expect(restoredChain).toBe('v1');

    await createBackup({ memphisRoot, backupRoot, tag: 'daily' });
    await createBackup({ memphisRoot, backupRoot, tag: 'daily' });

    const dryRun = await cleanBackups({ memphisRoot, backupRoot, keep: 2, dryRun: true });
    expect(dryRun.removed.length).toBe(0);
    expect(dryRun.wouldRemove.length).toBeGreaterThan(0);

    const cleaned = await cleanBackups({ memphisRoot, backupRoot, keep: 2, dryRun: false });
    expect(cleaned.removed.length).toBeGreaterThan(0);

    const afterClean = await listBackups({ memphisRoot, backupRoot });
    expect(afterClean.backups.length).toBeLessThanOrEqual(2);
  }, 40000);

  it('rejects backups that contain unsafe archive entry paths', async () => {
    const root = mkdtempSync(join(tmpdir(), 'memphis-backup-unsafe-'));
    const memphisRoot = join(root, '.memphis');
    const backupRoot = join(memphisRoot, 'backups');
    mkdirSync(backupRoot, { recursive: true });

    const archiveName = 'unsafe-backup.tar.gz';
    const archivePath = join(backupRoot, archiveName);
    const payload = {
      format: 'memphis-backup-v1',
      entries: [{ path: '../escape.txt', kind: 'file', contentBase64: Buffer.from('x').toString('base64') }],
    };
    writeFileSync(archivePath, gzipSync(Buffer.from(JSON.stringify(payload), 'utf8')));

    const checksum = createHash('sha256').update(readFileSync(archivePath)).digest('hex');
    writeFileSync(join(backupRoot, `${archiveName}.sha256`), `${checksum}  ${archiveName}\n`, 'utf8');

    const verified = await verifyBackup({ file: archiveName, memphisRoot, backupRoot });
    expect(verified.valid).toBe(false);

    await expect(
      restoreBackup({ file: archiveName, memphisRoot, backupRoot, confirm: true }),
    ).rejects.toThrow(/Checksum verification failed/);
  });
});
