import { execFileSync } from 'node:child_process';
import * as crypto from 'node:crypto';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';

import { drillBackup } from '../../src/infra/cli/commands/backup.js';
import { hashBlock } from '../../src/infra/storage/chain-adapter.js';

const roots: string[] = [];
afterEach(() => roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true })));
function fixture(corrupt: boolean) {
  const root = mkdtempSync(join(tmpdir(), 'backup-content-drill-'));
  roots.push(root);
  mkdirSync(join(root, 'source', 'chains', 'journal'), { recursive: true });
  const block = {
    index: 0,
    chain: 'journal',
    timestamp: '2026-01-01T00:00:00.000Z',
    prev_hash: '0'.repeat(64),
    data: { type: 'journal', content: 'retained memory' },
  };
  writeFileSync(
    join(root, 'source', 'chains', 'journal', '000000.json'),
    JSON.stringify({ ...block, hash: hashBlock(block, crypto) }),
  );
  const databasePath = join(root, 'source', 'memory.db');
  const db = new Database(databasePath);
  db.exec("CREATE TABLE memory (content TEXT); INSERT INTO memory VALUES ('retained memory')");
  db.close();
  if (corrupt) writeFileSync(databasePath, 'not a SQLite database');
  const archive = join(root, 'fixture.tar.gz');
  execFileSync('tar', ['-czf', archive, '-C', join(root, 'source'), '.']);
  writeFileSync(
    `${archive}.sha256`,
    `${createHash('sha256').update(readFileSync(archive)).digest('hex')}  fixture.tar.gz\n`,
  );
  return { archive, databasePath };
}

/**
 * A chain directory left behind by a rebuild-hashes run. Its name carries a
 * dot and a timestamp, so it does not match the safe chain-name shape.
 */
function backupChainFixture(): { archive: string; root: string } {
  const root = mkdtempSync(join(tmpdir(), 'backup-chain-drill-'));
  roots.push(root);
  mkdirSync(join(root, 'source', 'chains', 'journal'), { recursive: true });
  mkdirSync(join(root, 'source', 'chains', 'journal.backup-1792925651264'), { recursive: true });
  const block = {
    index: 0,
    chain: 'journal',
    timestamp: '2026-01-01T00:00:00.000Z',
    prev_hash: '0'.repeat(64),
    data: { type: 'journal', content: 'retained memory' },
  };
  for (const dir of ['journal', 'journal.backup-1792925651264']) {
    writeFileSync(
      join(root, 'source', 'chains', dir, '000000.json'),
      JSON.stringify({ ...block, hash: hashBlock(block, crypto) }),
    );
  }
  const archive = join(root, 'fixture.tar.gz');
  execFileSync('tar', ['-czf', archive, '-C', join(root, 'source'), '.']);
  writeFileSync(
    `${archive}.sha256`,
    `${createHash('sha256').update(readFileSync(archive)).digest('hex')}  fixture.tar.gz\n`,
  );
  return { archive, root };
}

describe('backup content drill', () => {
  it('validates large listings instead of failing at the default child-process buffer limit', async () => {
    const root = mkdtempSync(join(tmpdir(), 'backup-large-listing-'));
    roots.push(root);
    const source = join(root, 'source');
    const nested = join(source, ...Array.from({ length: 12 }, (_, i) => `${i}-${'x'.repeat(88)}`));
    mkdirSync(nested, { recursive: true });
    for (let i = 0; i < 1100; i++) writeFileSync(join(nested, `artifact-${i}.txt`), '');
    const archive = join(root, 'large.tar.gz');
    execFileSync('tar', ['-czf', archive, '-C', source, '.']);
    // Exercise both real tar listing paths beyond 1 MiB, without mocking
    // execFileSync or merely asserting that a buffer option was passed.
    const names = execFileSync('tar', ['-tzf', archive], { maxBuffer: 8 * 1024 * 1024 });
    expect(names.length).toBeGreaterThan(1024 * 1024);
    writeFileSync(
      `${archive}.sha256`,
      `${createHash('sha256').update(readFileSync(archive)).digest('hex')}  large.tar.gz\n`,
    );
    const result = await drillBackup(archive);
    expect(result.verification).toBe('extracted-chain-sqlite');
    expect(result.credentialRecovery).toBe('not-verified');
    symlinkSync('missing-target', join(nested, 'unsafe-link'));
    const unsafe = join(root, 'unsafe-large.tar.gz');
    execFileSync('tar', ['-czf', unsafe, '-C', source, '.']);
    writeFileSync(
      `${unsafe}.sha256`,
      `${createHash('sha256').update(readFileSync(unsafe)).digest('hex')}  unsafe-large.tar.gz\n`,
    );
    await expect(drillBackup(unsafe)).rejects.toThrow('refuses links and special files');
  }, 30_000);

  it('extracts and verifies actual chains and SQLite without modifying source', async () => {
    const { archive, databasePath } = fixture(false);
    const before = readFileSync(databasePath);
    const result = await drillBackup(archive);
    expect(result.blocksChecked).toBeGreaterThan(0);
    expect(result.databasesChecked).toBe(1);
    expect(result.credentialRecovery).toBe('not-verified');
    expect(readFileSync(databasePath)).toEqual(before);
  });
  it('rejects a listable, checksum-valid archive with corrupt SQLite', async () => {
    const { archive } = fixture(true);
    await expect(drillBackup(archive)).rejects.toThrow();
  });

  // The drill must not abort on a chain directory whose name is outside the
  // safe chain-name shape (a rebuild-hashes backup). It happened on this
  // host: every scheduled backup reported "restore-drill FAILED — invalid
  // chain name" while the archive itself was complete and correct.
  it('skips chain directories whose name is not a safe chain name', async () => {
    const { archive } = backupChainFixture();
    const result = await drillBackup(archive);
    // The real chain is still verified.
    expect(result.chainsChecked).toBe(1);
    expect(result.blocksChecked).toBeGreaterThan(0);
  });
});
