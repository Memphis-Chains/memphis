import { existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { pruneSnapshots } from '../../src/backup/snapshot-pruner.js';

describe('snapshot pruner', () => {
  it('removes snapshot archive sidecars together with old metadata', async () => {
    const snapshotDir = mkdtempSync(join(tmpdir(), 'mv4-snapshot-pruner-'));
    const oldTs = Date.now() - 10 * 24 * 60 * 60 * 1000;
    const newTs = Date.now();

    const oldId = `snapshot-${oldTs}`;
    const newId = `snapshot-${newTs}`;

    writeFileSync(
      join(snapshotDir, `${oldId}.json`),
      JSON.stringify({ id: oldId, archiveFile: `${oldId}-archive.tar.gz` }),
      'utf8',
    );
    writeFileSync(join(snapshotDir, `${oldId}-archive.tar.gz`), 'old-archive', 'utf8');
    writeFileSync(join(snapshotDir, `${oldId}-archive.tar.gz.sha256`), 'old-checksum', 'utf8');

    writeFileSync(
      join(snapshotDir, `${newId}.json`),
      JSON.stringify({ id: newId, archiveFile: `${newId}-archive.tar.gz` }),
      'utf8',
    );
    writeFileSync(join(snapshotDir, `${newId}-archive.tar.gz`), 'new-archive', 'utf8');
    writeFileSync(join(snapshotDir, `${newId}-archive.tar.gz.sha256`), 'new-checksum', 'utf8');

    const out = await pruneSnapshots(snapshotDir, {
      maxAgeMs: 7 * 24 * 60 * 60 * 1000,
      minKeep: 1,
    });

    expect(out.pruned).toBe(1);
    expect(existsSync(join(snapshotDir, `${oldId}.json`))).toBe(false);
    expect(existsSync(join(snapshotDir, `${oldId}-archive.tar.gz`))).toBe(false);
    expect(existsSync(join(snapshotDir, `${oldId}-archive.tar.gz.sha256`))).toBe(false);
    expect(existsSync(join(snapshotDir, `${newId}.json`))).toBe(true);
    expect(existsSync(join(snapshotDir, `${newId}-archive.tar.gz`))).toBe(true);
  });
});
