// The plain Node systemd runner and the compiled CLI use the same implementation.
//
// This is a hand-maintained list, which is exactly how the two writers drift:
// adding an export to the module silently failed to reach the CLI until
// `tsc` caught it. `db-snapshot-contract.test.ts` asserts that every runtime
// export of the module is re-exported here; `backup-manifest-contract.test.ts`
// asserts the same for this one.
export {
  BACKUP_SUFFIX,
  DEFAULT_RETENTION_POLICY,
  DEFAULT_TAG,
  MANIFEST_FILE_NAME,
  deriveTagFromFileName,
  listArchiveFiles,
  readManifest,
  reconciledManifest,
  reconcileManifest,
  removeManifestEntries,
  upsertManifestEntry,
  writeManifest,
  type BackupManifest,
  type BackupManifestEntry,
} from '../../../../scripts/backup-manifest.mjs';
