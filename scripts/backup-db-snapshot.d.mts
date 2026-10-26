// Type declarations for backup-db-snapshot.mjs. TypeScript cannot infer types
// across the .mjs boundary, so `tsc --noEmit` fails with TS7016 when this file
// is absent — verified by moving it aside and reading the compiler output.
//
// knip reports it as an unused FILE because nothing imports a `.d.mts`: it is
// consumed by the compiler, not by another module. It is listed in knip.json's
// `ignore` for that reason — not because the type surface is optional.
export const SNAPSHOT_DIR_NAME: string;
export const STAGED_PREFIX: string;
export const DATABASE_PLACEMENT_MANIFEST: string;
export const RUNTIME_DB_PREFIX: string;

/**
 * Where a snapshotted database belongs.
 *
 * `data-dir` — inside the data directory; restored relative to it.
 * `runtime`  — the database `DATABASE_URL` names, which lives outside the
 *              data directory; restored to the path the runtime reads.
 */
export type DatabaseRole = 'data-dir' | 'runtime';

export type DatabaseSnapshotResult = {
  ok: boolean;
  snapshotDir: string;
  snapshotted: Array<{
    file: string;
    archivePath: string;
    stagedPath: string;
    source: string;
    bytes: number;
    role: DatabaseRole;
  }>;
  excludedPaths: string[];
  errors: string[];
};

export function snapshotDatabases(options: {
  memphisRoot: string;
  dataDir?: string;
  databasePath?: string;
}): Promise<DatabaseSnapshotResult>;
export function cleanupDatabaseSnapshots(snapshot: DatabaseSnapshotResult): void;
export function tarSubstitutionFlags(substitution: string): string[];
export function databasePlacementManifest(snapshot: DatabaseSnapshotResult): {
  manifestName: string;
  content: string;
};
export function tarSupportsWarningOpt(): boolean;
export function tarWarningFlags(): string[];
export function databaseSnapshotTarArgs(
  snapshot: DatabaseSnapshotResult,
  memphisRoot: string,
): string[];
export function verifyDatabaseSnapshotEntries(
  snapshot: DatabaseSnapshotResult,
  entries: string[],
): void;
