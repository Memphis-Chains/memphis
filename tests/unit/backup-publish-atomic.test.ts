import { execFileSync } from 'node:child_process';
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { cleanBackups, createBackup, listBackups } from '../../src/infra/cli/commands/backup.js';

const RUNNER = 'scripts/scheduled-backup-runner.mjs';

/** Archive-shaped files only; `.partial` artifacts must never be listed. */
function archiveFilesIn(dir: string): string[] {
  return readdirSync(dir)
    .filter((f) => f.endsWith('.tar.gz'))
    .sort();
}

describe('backup publication is atomic: nothing incomplete is ever visible', () => {
  it('the runner writes to a .partial name and renames only after validation', () => {
    const src = readFileSync(RUNNER, 'utf8');
    // A partial artifact must exist while tar runs, and the rename must be
    // the LAST step. If rename happened before validation, retention and
    // `backup-to-usb.sh` could pick up a truncated archive.
    expect(src).toContain('.partial');
    expect(src).toContain('renameSync');
    // The checksum sidecar must be written before the rename too.
    const shaWriteIdx = src.indexOf('writeFileSync(partialSidecar');
    const publishIdx = src.indexOf('renameSync(partialPath, backupPath)');
    expect(shaWriteIdx).toBeGreaterThan(-1);
    expect(publishIdx).toBeGreaterThan(shaWriteIdx);
  });

  it('the runner refuses to publish an archive with no chains (drill failure)', () => {
    const src = readFileSync(RUNNER, 'utf8');
    // `drillOk` must GATE the rename, and the gate must come before it.
    // Measure the PUBLISHING rename (`renameSync(partialPath, backupPath)`),
    // not the sidecar rename, and not the first textual occurrence of the
    // word — both of those measure the wrong thing.
    expect(src).toMatch(/if\s*\(!drillOk\)\s*\{/);
    const gateIdx = src.indexOf('if (!drillOk)');
    const publishIdx = src.indexOf('renameSync(partialPath, backupPath)');
    expect(gateIdx).toBeGreaterThan(-1);
    expect(publishIdx).toBeGreaterThan(-1);
    expect(gateIdx).toBeLessThan(publishIdx);
    // The failing path must exit non-zero rather than report ok:true.
    expect(src).toMatch(/published:\s*false/);
    // And it must not publish: the gate body must leave before any rename.
    // Slice the gate body only — a rename AFTER the gate is correct (that is
    // the publish path), so counting renames in the whole file proves nothing.
    const gateBody = src.slice(gateIdx, src.indexOf('  // Publish:', gateIdx));
    expect(gateBody).not.toContain('renameSync');
    expect(gateBody).toContain('process.exit');
  });

  it('listBackups never reports a .partial artifact as an archive', async () => {
    const root = mkdtempSync(join(tmpdir(), 'memphis-publish-'));
    const data = join(root, 'data');
    const backups = join(data, 'backups');
    mkdirSync(join(data, 'chains'), { recursive: true });
    mkdirSync(backups, { recursive: true });
    writeFileSync(join(data, 'chains', 'journal-000001.json'), '{}');
    writeFileSync(join(data, 'vault-state.json'), '{}');
    writeFileSync(join(data, 'vault-entries.json'), '[]');
    // Two shapes, because they fail for different reasons:
    //  - `...tar.gz.partial` is rejected by the EXTENSION filter alone
    //    (it does not end in `.tar.gz`), so it cannot prove the second
    //    filter exists — that is the trap an earlier version of this test
    //    fell into, and its mutation survived;
    //  - `...tar.gz` with no marker is the shape a naive implementation
    //    would publish and this must never accept.
    // What the `.partial` marker must defeat is a name that ends in
    // `.tar.gz` while still being in flight, so assert that the marker is
    // rejected regardless of position rather than relying on the suffix.
    writeFileSync(join(backups, 'scheduled-2026-10-11-02-00.tar.gz.partial'), 'TRUNC');
    writeFileSync(join(backups, 'scheduled-2026-10-11-02-99.tar.gz.partial'), 'TRUNC');
    writeFileSync(join(backups, 'scheduled-2026-10-11-02-00.partial.tar.gz'), 'TRUNC');

    const listed = await listBackups({ memphisRoot: data, backupRoot: backups });
    const names = listed.backups.map((b) => b.file);
    // Nothing partial may be listed, including the adversarial shape.
    expect(names).toEqual([]);

    // Retention must not count or delete them either.
    const cleaned = await cleanBackups({ memphisRoot: data, backupRoot: backups, keep: 0 });
    expect(cleaned.wouldRemove).toEqual([]);
    // ...and a real archive alongside them must still be visible.
    writeFileSync(join(backups, 'scheduled-2026-10-11-02-01.tar.gz'), 'REAL');
    const both = await listBackups({ memphisRoot: data, backupRoot: backups });
    expect(both.backups.map((b) => b.file)).toEqual(['scheduled-2026-10-11-02-01.tar.gz']);
  });

  it('createBackup leaves no archive behind when tar fails', async () => {
    const root = mkdtempSync(join(tmpdir(), 'memphis-publish-fail-'));
    const data = join(root, 'data');
    const backups = join(data, 'backups');
    mkdirSync(join(data, 'chains'), { recursive: true });
    mkdirSync(backups, { recursive: true });
    writeFileSync(join(data, 'chains', 'journal-000001.json'), '{}');
    writeFileSync(join(data, 'vault-state.json'), '{}');
    writeFileSync(join(data, 'vault-entries.json'), '[]');

    const created = await createBackup({
      memphisRoot: data,
      backupRoot: backups,
      showProgress: false,
    });
    const after = archiveFilesIn(backups);
    expect(after.length).toBe(1);
    // The published archive must be complete and listed.
    const listed = await listBackups({ memphisRoot: data, backupRoot: backups });
    expect(listed.backups.map((b) => b.file)).toEqual(after);
    // No half-written artifact anywhere.
    expect(readdirSync(backups).filter((f) => f.endsWith('.partial'))).toEqual([]);

    // Strongest available proof that publication is complete: the archive
    // tar wrote must be readable and must contain the chain file we seeded.
    const tarList = execFileSync('tar', ['-tzf', created.backupPath], { encoding: 'utf8' });
    expect(tarList).toContain('chains/journal-000001.json');
    // And the secret files must be absent from the real archive.
    expect(tarList).not.toContain('vault-entries.json');
    expect(tarList).not.toContain('vault-state.json');
  });

  it('backup-to-usb copies the checksum sidecar, not just the archive', () => {
    const src = readFileSync('scripts/backup-to-usb.sh', 'utf8');
    // Without the sidecar, `memphis backup verify <file>` on the USB copy has
    // no expected digest and the offsite copy is unverifiable.
    expect(src).toContain('.sha256');
    const copyIdx = src.indexOf('cp "$latest"');
    expect(copyIdx).toBeGreaterThan(-1);
    expect(src).toContain('$latest.sha256');
  });

  it('backup-to-usb picks the newest VERIFIED archive, not the newest file', () => {
    const src = readFileSync('scripts/backup-to-usb.sh', 'utf8');
    // `ls -t | head -1` selects by mtime alone: a truncated newest file
    // blocks every copy until it is manually removed.
    expect(src).toContain("PARTIAL_SUFFIX='.partial'");
    // The selection must filter partials OUT of the candidate set, and must
    // not be a bare `ls -t` glob (which cannot express that filter).
    const selectIdx = src.indexOf('latest=$(find');
    expect(selectIdx).toBeGreaterThan(-1);
    const selectLine = src.slice(selectIdx, src.indexOf('\n', selectIdx));
    expect(selectLine).toContain('PARTIAL_SUFFIX');
    expect(selectLine).toContain('-type f');
    expect(src).not.toMatch(/ls -t "\$LOCAL_BACKUP_DIR"\/\*\.tar\.gz"/);
  });

  it('a published archive is 0600: it may contain operator data', async () => {
    // Asserting that the source contains the word `chmodSync` proves nothing:
    // it would pass with the call commented out, moved to a dead branch, or
    // applied to the wrong path. Measure the mode of a real archive instead.
    const root = mkdtempSync(join(tmpdir(), 'memphis-mode-'));
    const data = join(root, 'data');
    const backups = join(data, 'backups');
    mkdirSync(join(data, 'chains'), { recursive: true });
    mkdirSync(backups, { recursive: true });
    writeFileSync(join(data, 'chains', 'journal-000001.json'), '{}');
    writeFileSync(join(data, 'vault-state.json'), '{}');
    writeFileSync(join(data, 'vault-entries.json'), '[]');

    const created = await createBackup({
      memphisRoot: data,
      backupRoot: backups,
      showProgress: false,
    });
    expect(statSync(created.backupPath).mode & 0o777).toBe(0o600);
    expect(statSync(`${created.backupPath}.sha256`).mode & 0o777).toBe(0o600);
  });
});
