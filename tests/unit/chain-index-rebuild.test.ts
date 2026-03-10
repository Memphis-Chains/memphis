import { describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { rebuildChainIndexes } from '../../src/core/chain-index-rebuild.js';

function setupChains(): string {
  const dir = mkdtempSync(join(tmpdir(), 'mv4-index-rebuild-'));
  mkdirSync(dir, { recursive: true });

  const journal = [
    { hash: 'j1', timestamp: '2026-03-10T10:00:00Z', tags: ['ops', 'daily'] },
    { hash: 'j2', timestamp: '2026-03-10T11:00:00Z', tags: ['ops'] },
  ];
  const ask = [{ hash: 'a1', timestamp: '2026-03-10T12:00:00Z', tags: ['chat'] }];
  const decision = [{ hash: 'd1', timestamp: '2026-03-10T13:00:00Z', tags: ['decision'] }];

  writeFileSync(join(dir, 'journal.jsonl'), journal.map((x) => JSON.stringify(x)).join('\n'));
  writeFileSync(join(dir, 'ask.jsonl'), ask.map((x) => JSON.stringify(x)).join('\n'));
  writeFileSync(join(dir, 'decision.jsonl'), decision.map((x) => JSON.stringify(x)).join('\n'));

  return dir;
}

describe('chain index rebuild', () => {
  it('rebuilds hash/timestamp/tags indexes and creates backup by default', () => {
    const dir = setupChains();

    writeFileSync(join(dir, 'journal.index.hash.json'), '{ bad-json');

    const report = rebuildChainIndexes({ chainDir: dir, now: new Date('2026-03-10T00:00:00Z') });

    expect(report.entries).toBe(4);
    expect(report.before.corrupted).toBeGreaterThan(0);
    expect(report.after.corrupted).toBe(0);
    expect(report.backupDir).toContain('.index-backup-2026-03-10');

    const hash = JSON.parse(readFileSync(join(dir, 'journal.index.hash.json'), 'utf8')) as Record<string, number>;
    const tags = JSON.parse(readFileSync(join(dir, 'journal.index.tags.json'), 'utf8')) as Record<string, string[]>;

    expect(hash.j1).toBe(0);
    expect(hash.j2).toBe(1);
    expect(tags.ops).toEqual(['j1', 'j2']);
  });

  it('supports dry-run without writing index files', () => {
    const dir = setupChains();

    const report = rebuildChainIndexes({ chainDir: dir, dryRun: true });

    expect(report.dryRun).toBe(true);
    expect(report.backupDir).toBeUndefined();
    expect(readdirSync(dir).some((name) => name.includes('.index.'))).toBe(false);
  });

  it('skips backup when --no-backup mode is used', () => {
    const dir = setupChains();

    const report = rebuildChainIndexes({ chainDir: dir, noBackup: true, now: new Date('2026-03-10T00:00:00Z') });

    expect(report.after.corrupted).toBe(0);
    expect(report.backupDir).toBeUndefined();
    expect(readdirSync(dir).some((name) => name.startsWith('.index-backup-'))).toBe(false);
  });
});
