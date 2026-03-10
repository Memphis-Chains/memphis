import { describe, expect, it } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execSync } from 'node:child_process';

describe('CLI chain index rebuild', () => {
  it('runs rebuild and prints structured text report', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mv4-cli-index-rebuild-'));
    writeFileSync(join(dir, 'journal.jsonl'), `${JSON.stringify({ hash: 'j1', timestamp: '2026-03-10T10:00:00Z', tags: ['t1'] })}\n`);
    writeFileSync(join(dir, 'ask.jsonl'), `${JSON.stringify({ hash: 'a1', timestamp: '2026-03-10T11:00:00Z', tags: ['t2'] })}\n`);
    writeFileSync(join(dir, 'decision.jsonl'), `${JSON.stringify({ hash: 'd1', timestamp: '2026-03-10T12:00:00Z', tags: ['t3'] })}\n`);

    const out = execSync(`MEMPHIS_CHAIN_DIR=${dir} npx tsx src/infra/cli/index.ts chain index rebuild`, {
      encoding: 'utf8',
    });

    expect(out).toContain('Chain Index Rebuild');
    expect(out).toContain('Rebuilding...');
    expect(out).toContain('journal: 1 entries');
    expect(out).toContain('ask: 1 entries');
    expect(out).toContain('decision: 1 entries');
    expect(out).toContain('Backup saved to:');
  });

  it('supports --dry-run and JSON output', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mv4-cli-index-rebuild-json-'));
    writeFileSync(join(dir, 'journal.jsonl'), `${JSON.stringify({ hash: 'j1', timestamp: '2026-03-10T10:00:00Z', tags: ['t1'] })}\n`);
    writeFileSync(join(dir, 'ask.jsonl'), `${JSON.stringify({ hash: 'a1', timestamp: '2026-03-10T11:00:00Z', tags: ['t2'] })}\n`);
    writeFileSync(join(dir, 'decision.jsonl'), `${JSON.stringify({ hash: 'd1', timestamp: '2026-03-10T12:00:00Z', tags: ['t3'] })}\n`);

    const out = execSync(`MEMPHIS_CHAIN_DIR=${dir} npx tsx src/infra/cli/index.ts chain index rebuild --dry-run --json`, {
      encoding: 'utf8',
    });

    const data = JSON.parse(out);
    expect(data.mode).toBe('chain-index-rebuild');
    expect(data.dryRun).toBe(true);
    expect(data.backupDir).toBeUndefined();
  });
});
