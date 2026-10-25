import { execFileSync } from 'node:child_process';
import * as crypto from 'node:crypto';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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

describe('backup content drill', () => {
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
});
