// Type declarations for backup-db-snapshot.mjs. TypeScript cannot infer types
// across the .mjs boundary, so `tsc --noEmit` fails with TS7016 when this file
// is absent — verified by moving it aside and reading the compiler output.
//
// knip reports it as an unused FILE because nothing imports a `.d.mts`: it is
// consumed by the compiler, not by another module. It is listed in knip.json's
// `ignore` for that reason — not because the type surface is optional.
export const SNAPSHOT_DIR_NAME: string;

export type DatabaseSnapshotResult = {
  ok: boolean;
  snapshotDir: string;
  snapshotted: Array<{ file: string; archivePath: string; source: string; bytes: number }>;
  excludedPaths: string[];
  errors: string[];
};

export function snapshotDatabases(options: {
  memphisRoot: string;
  dataDir?: string;
  databasePath?: string;
}): Promise<DatabaseSnapshotResult>;
export function cleanupDatabaseSnapshots(snapshot: DatabaseSnapshotResult): void;
export function databaseSnapshotTarArgs(
  snapshot: DatabaseSnapshotResult,
  memphisRoot: string,
): string[];
export function verifyDatabaseSnapshotEntries(
  snapshot: DatabaseSnapshotResult,
  entries: string[],
): void;
