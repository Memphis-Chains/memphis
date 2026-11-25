// The plain Node systemd runner and the compiled CLI use the same implementation.
//
// This is a hand-maintained list, which is exactly how the two writers drift:
// adding an export to the module silently failed to reach the CLI until
// `tsc` caught it. `backup-tar-contract.test.ts` asserts that every runtime
// export of the module is re-exported here.
export {
  MAX_TAR_LIST_BYTES,
  TarError,
  describeTarFailure,
  isTarExecutionError,
  isTarFileChangedWarning,
  runTar,
  tarCreateArchive,
  tarExtractArchive,
  tarListArchiveContents,
  tarListArchiveVerbose,
} from '../../../../scripts/backup-tar.mjs';
