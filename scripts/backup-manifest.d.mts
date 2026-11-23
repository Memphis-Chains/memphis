// Type declarations for backup-manifest.mjs. TypeScript cannot infer types
// across the .mjs boundary, so `tsc --noEmit` fails with TS7016 when this file
// is absent — verified by moving it aside and reading the compiler output.
//
// knip reports it as an unused FILE because nothing imports a `.d.mts`: it is
// consumed by the compiler, not by another module. It is listed in knip.json's
// `ignore` for that reason — not because the type surface is optional.
export const MANIFEST_FILE_NAME: string;
export const BACKUP_SUFFIX: string;
export const DEFAULT_TAG: string;
export const DEFAULT_RETENTION_POLICY: Readonly<{
  keepDaily: number;
  keepWeekly: number;
  keepMonthly: number;
}>;

/** One archive, as the index records it. */
export type BackupManifestEntry = {
  file: string;
  tag: string;
  timestamp: string;
  size: number;
  checksum: string;
  fileCount: number;
};

export type BackupManifest = {
  backups: BackupManifestEntry[];
  retentionPolicy: {
    keepDaily: number;
    keepWeekly: number;
    keepMonthly: number;
  };
};

/** The tag an archive name carries: everything in front of its timestamp. */
export function deriveTagFromFileName(file: string): string;

/** The archives on disk. A partial artifact is in flight, never an archive. */
export function listArchiveFiles(backupRoot: string): string[];

/** The manifest as it stands. An unreadable manifest is an empty manifest. */
export function readManifest(backupRoot: string): BackupManifest;

export function writeManifest(backupRoot: string, manifest: BackupManifest): void;

/** The manifest the disk supports: ghosts dropped, missing archives added. */
export function reconciledManifest(backupRoot: string): BackupManifest;

export function reconcileManifest(backupRoot: string): {
  manifest: BackupManifest;
  changed: boolean;
};

/** Record one archive. The index is reconciled first, so it stays truthful. */
export function upsertManifestEntry(
  backupRoot: string,
  entry: BackupManifestEntry,
): BackupManifest;

/** Forget the named archives. The index is reconciled first. */
export function removeManifestEntries(backupRoot: string, files: string[]): BackupManifest;
