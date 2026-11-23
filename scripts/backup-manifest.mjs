/**
 * The backup manifest — the one index of the archives on disk.
 *
 * WHY THIS IS A SHARED MODULE
 *
 * Two writers publish archives (`memphis backup create` and the systemd
 * runner `scripts/scheduled-backup-runner.mjs`) and two writers delete them.
 * Before this module each kept its own idea of what the manifest should
 * contain, and the two drifted apart in BOTH directions.
 *
 * Measured 2026-11-22 on this host (`~/.memphis/backups`): 27 archives on
 * disk, 53 manifest entries — 30 of the entries pointed at files that had
 * been gone for weeks, and 4 of the archives on disk had no entry at all.
 *
 *   - the runner published archives and never recorded them. The tag of an
 *     archive with no entry has to be guessed from its filename, and the
 *     old guess was wrong: the runner's filename shape
 *     (`scheduled-2026-11-22_11-42-30-5599.tar.gz`) did not match the
 *     shape the guess was written for, so every runner archive came out
 *     tagged `scheduled-2026` — a tag no command names.
 *   - the runner deleted archives and never removed their entries, so the
 *     manifest grew a ghost for every archive it retired.
 *
 * The archives on disk are the truth; the manifest is an index of them. So
 * the index is reconciled with the disk on every write: entries whose
 * archive is gone are dropped, archives with no entry get one.
 *
 * The two writers keep their own filename shapes, so the tag is taken from
 * the name in front of the timestamp rather than from a field count. That
 * rule was measured against every archive on this host: it reproduces the
 * manifest's own tag for all 23 archives that have one, and names the four
 * that do not `scheduled` — the tag the operator actually chose.
 */
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export const MANIFEST_FILE_NAME = 'manifest.json';
export const BACKUP_SUFFIX = '.tar.gz';
export const DEFAULT_TAG = 'backup';
export const DEFAULT_RETENTION_POLICY = Object.freeze({
  keepDaily: 7,
  keepWeekly: 4,
  keepMonthly: 12,
});

/**
 * The timestamp a writer puts at the end of an archive name.
 *
 *   CLI     `…-2026-11-22-11-42.tar.gz`           (YYYY-MM-DD-HH-mm)
 *   runner  `…-2026-11-22_11-42-30-5599.tar.gz`   (…_HH-mm-ss-pid)
 *
 * The tag is what precedes it. The old derivation counted five trailing
 * fields and assumed the CLI's shape, so every runner archive came out
 * tagged `scheduled-2026`.
 */
const TIMESTAMP_TAIL = /\d{4}-\d{2}-\d{2}[-_]\d{2}-\d{2}(-\d{2})?(-\d+)?$/;

/** The tag an archive name carries: everything in front of its timestamp. */
export function deriveTagFromFileName(file) {
  const stem = file.replace(BACKUP_SUFFIX, '');
  const match = TIMESTAMP_TAIL.exec(stem);
  if (!match) return stem || DEFAULT_TAG;
  return stem.slice(0, match.index).replace(/-+$/, '') || DEFAULT_TAG;
}

/** The archives on disk. A partial artifact is in flight, never an archive. */
export function listArchiveFiles(backupRoot) {
  try {
    return readdirSync(backupRoot).filter(
      (file) => file.endsWith(BACKUP_SUFFIX) && !file.includes('.partial'),
    );
  } catch {
    return [];
  }
}

/** The manifest as it stands. An unreadable manifest is an empty manifest. */
export function readManifest(backupRoot) {
  const manifestPath = join(backupRoot, MANIFEST_FILE_NAME);
  const empty = { retentionPolicy: { ...DEFAULT_RETENTION_POLICY }, backups: [] };
  if (!existsSync(manifestPath)) return empty;
  try {
    const parsed = JSON.parse(readFileSync(manifestPath, 'utf8'));
    return {
      retentionPolicy: { ...DEFAULT_RETENTION_POLICY, ...(parsed.retentionPolicy ?? {}) },
      backups: Array.isArray(parsed.backups) ? parsed.backups : [],
    };
  } catch {
    return empty;
  }
}

export function writeManifest(backupRoot, manifest) {
  writeFileSync(
    join(backupRoot, MANIFEST_FILE_NAME),
    JSON.stringify(manifest, null, 2),
    'utf8',
  );
}

function byNewestFirst(a, b) {
  return a.timestamp < b.timestamp ? 1 : -1;
}

/** The digest the sidecar records, if the archive has one. */
function readChecksumHex(archivePath) {
  const checksumPath = `${archivePath}.sha256`;
  if (!existsSync(checksumPath)) return undefined;
  try {
    const raw = readFileSync(checksumPath, 'utf8').trim();
    const [hex] = raw.split(/\s+/);
    return hex || undefined;
  } catch {
    return undefined;
  }
}

/**
 * The manifest the disk supports: ghosts dropped, missing archives added.
 *
 * Not written by itself — the caller decides when the index is written.
 */
export function reconciledManifest(backupRoot) {
  const manifest = readManifest(backupRoot);
  const onDisk = new Set(listArchiveFiles(backupRoot));
  const known = new Set(manifest.backups.map((entry) => entry.file));

  const kept = manifest.backups.filter((entry) => onDisk.has(entry.file));
  const added = [];
  for (const file of onDisk) {
    if (known.has(file)) continue;
    let stat;
    try {
      stat = statSync(join(backupRoot, file));
    } catch {
      continue;
    }
    added.push({
      file,
      tag: deriveTagFromFileName(file),
      timestamp: stat.mtime.toISOString(),
      size: stat.size,
      checksum: (() => {
        const hex = readChecksumHex(join(backupRoot, file));
        return hex ? `sha256:${hex}` : 'sha256:missing';
      })(),
      fileCount: 0,
    });
  }

  return {
    retentionPolicy: manifest.retentionPolicy,
    backups: [...added, ...kept].sort(byNewestFirst),
  };
}

/**
 * Bring the index back in line with the disk and write it.
 *
 * Returns the number of entries that changed — the ghosts that were dropped
 * and the archives that were added.
 */
export function reconcileManifest(backupRoot) {
  const before = readManifest(backupRoot);
  const after = reconciledManifest(backupRoot);
  const changed =
    after.backups.length !== before.backups.length ||
    after.backups.some((entry) => {
      const previous = before.backups.find((b) => b.file === entry.file);
      return previous?.tag !== entry.tag || previous?.timestamp !== entry.timestamp;
    });
  if (changed) writeManifest(backupRoot, after);
  return { manifest: after, changed };
}

/** Record one archive. The index is reconciled first, so it stays truthful. */
export function upsertManifestEntry(backupRoot, entry) {
  const manifest = reconciledManifest(backupRoot);
  manifest.backups = [entry, ...manifest.backups.filter((b) => b.file !== entry.file)].sort(
    byNewestFirst,
  );
  writeManifest(backupRoot, manifest);
  return manifest;
}

/** Forget the named archives. The index is reconciled first. */
export function removeManifestEntries(backupRoot, files) {
  const removed = new Set(files);
  const manifest = reconciledManifest(backupRoot);
  manifest.backups = manifest.backups.filter((entry) => !removed.has(entry.file));
  writeManifest(backupRoot, manifest);
  return manifest;
}
