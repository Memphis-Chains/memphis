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
  gnuTar?: boolean,
): string[];
export function verifyDatabaseSnapshotEntries(
  snapshot: DatabaseSnapshotResult,
  entries: string[],
): void;
