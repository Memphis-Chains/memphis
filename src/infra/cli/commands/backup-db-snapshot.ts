// The plain Node systemd runner and the compiled CLI use the same implementation.
//
// This is a hand-maintained list, which is exactly how the two writers drift:
// adding an export to the module silently failed to reach the CLI until
// `tsc` caught it. `db-snapshot-contract.test.ts` asserts that every runtime
// export of the module is re-exported here.
export {
  DATABASE_PLACEMENT_MANIFEST,
  SNAPSHOT_DIR_NAME,
  STAGED_PREFIX,
  cleanupDatabaseSnapshots,
  databasePlacementManifest,
  databaseSnapshotTarArgs,
  snapshotDatabases,
  tarSubstitutionFlags,
  tarSupportsWarningOpt,
  tarWarningFlags,
  verifyDatabaseSnapshotEntries,
  type DatabaseSnapshotResult,
} from '../../../../scripts/backup-db-snapshot.mjs';
