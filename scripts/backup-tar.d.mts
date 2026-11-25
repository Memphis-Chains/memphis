// Type declarations for backup-tar.mjs. TypeScript cannot infer types
// across the .mjs boundary, so `tsc --noEmit` fails with TS7016 when this
// file is absent — verified by moving it aside and reading the compiler
// output.
//
// knip reports it as an unused FILE because nothing imports a `.d.mts`: it is
// consumed by the compiler, not by another module. It is listed in knip.json's
// `ignore` for that reason — not because the type surface is optional.
export const MAX_TAR_LIST_BYTES: number;

/**
 * The error every failed tar call raises, in the shape the callers have
 * always read: `status` is the exit code, `code` is the errno string when
 * tar could not be started at all, and `stderr` is tar's own complaint.
 */
export class TarError extends Error {
  code: string | number | null;
  status: number | null;
  signal: NodeJS.Signals | null;
  stderr: string;
  stdout: string;
  constructor(
    message: string,
    options?: {
      code?: string | number | null;
      status?: number | null;
      signal?: NodeJS.Signals | null;
      stderr?: string;
      stdout?: string;
    },
  );
}

/** Did tar fail to START (no binary, no permission) rather than fail at its job? */
export function isTarExecutionError(error: unknown): boolean;

/** tar's "file changed as we read it" exit code 1 — a non-fatal warning. */
export function isTarFileChangedWarning(error: unknown, archivePath: string): boolean;

/** tar's own reason, in the message the operator sees. */
export function describeTarFailure(error: unknown): Error;

/** Run tar without blocking the caller's event loop. */
export function runTar(
  args: string[],
  options?: { maxBuffer?: number; env?: NodeJS.ProcessEnv },
): Promise<{ stdout: string; stderr: string }>;

/** The names inside a tar archive. */
export function tarListArchiveContents(archivePath: string): Promise<string[]>;

/** The verbose listing — GNU tar prints the type first. */
export function tarListArchiveVerbose(archivePath: string): Promise<string>;

/** Write a gzip-compressed tar archive at `archivePath`. */
export function tarCreateArchive(archivePath: string, extraArgs?: string[]): Promise<void>;

/** Extract a gzip-compressed tar archive into `targetRoot`. */
export function tarExtractArchive(archivePath: string, targetRoot: string): Promise<void>;
