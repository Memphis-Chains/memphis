/**
 * THE OWNER OF THE TAR RULE.
 *
 * One rule, two runners: the compiled CLI (which the runtime calls from
 * inside its own event loop) and the plain-Node systemd runner
 * (`scripts/scheduled-backup-runner.mjs`). Before this module each of them
 * called `tar` on its own and classified its failures on its own, and the
 * classifications had already drifted — the runner grew its own copy of the
 * "file changed as we read it" rule while the CLI grew its own.
 *
 * WHY THE CALLS ARE ASYNCHRONOUS — the reason this module exists at all
 *
 * `execFileSync` blocks the calling thread until the child process exits.
 * In the CLI that thread is the RUNTIME's event loop, and the runtime is the
 * process systemd stops. Measured on this host, 2026-11-25:
 *
 *   02:00:05  backup.scheduled.start
 *   02:06:39  backup.scheduled.success   (182 229 559 bytes)
 *             ... the restore drill starts, and calls `execFileSync('tar',
 *                 ['-xzf', …])` — the event loop is now BLOCKED ...
 *   02:28:53  systemd: Stopping memphis.service  (SIGTERM to the cgroup)
 *             ... ZERO `shutdown.*` lines from the runtime: the signal
 *                 handler cannot run while the loop is blocked ...
 *   02:29:38  systemd: State 'stop-sigterm' timed out. Killing.
 *   02:29:38  SIGKILL, "Failed with result 'timeout'"
 *
 * The drill's tar was killed by the same SIGTERM, so the drill reported
 * "Command failed: tar -xzf …" and the nightly backup was marked failed —
 * a failure caused by the stop, not by the archive.
 *
 * A standalone reproduction of the same mechanism, on this host, with the
 * real 181 MB archive:
 *
 *   sync   tar 3 565 ms → heartbeat ticks during the tar: 0,
 *                      SIGTERM handler ran: never
 *   async  tar 3 565 ms → heartbeat ticks during the tar: 10,
 *                      SIGTERM handler ran: yes, delay 0 ms
 *
 * So the archive step must never be synchronous. The child process runs, the
 * loop keeps turning, and the runtime can still answer a stop signal.
 *
 * The one rule, stated once:
 *
 *   - tar is invoked ASYNCHRONOUSLY, never synchronously;
 *   - tar's stderr is always visible: in the operator's log on success, and
 *     in the error message on failure;
 *   - a failure is classified by the SAME rules for every caller, so
 *     "tar could not start" and "tar warned about a file that changed" are
 *     never confused with "tar failed".
 */

import { Buffer } from 'node:buffer';
import { execFile } from 'node:child_process';
import { statSync } from 'node:fs';

/**
 * A real 21k-file operator archive exceeds Node's default 1 MiB buffer on
 * verbose listing. Both listing paths stay bounded, but large enough for
 * ordinary runtime backups; oversized listings still fail closed.
 */
export const MAX_TAR_LIST_BYTES = 64 * 1024 * 1024;

/**
 * The error every failed tar call raises, in the shape the callers have
 * always read: `status` is the exit code, `code` is the errno string when
 * tar could not be started at all, and `stderr` is tar's own complaint.
 *
 * Node's asynchronous `execFile` attaches NEITHER `status` NOR `stderr` to
 * its error — the exit code arrives as a numeric `code`, and the stderr
 * arrives as the callback's third argument. Measured on this host:
 * `Object.keys(err)` was `['code', 'killed', 'signal', 'cmd']` and
 * `err.stderr` was `undefined`. Normalising here is what lets ONE set of
 * classification rules serve both the synchronous and the asynchronous path.
 */
export class TarError extends Error {
  constructor(message, options = {}) {
    super(message);
    this.name = 'TarError';
    /** The errno string ('ENOENT', 'EACCES', 'EPERM') or the exit code. */
    this.code = options.code ?? null;
    /** The exit code, or null when tar never ran. */
    this.status = options.status ?? null;
    /** The signal that killed tar, if any. */
    this.signal = options.signal ?? null;
    /** tar's own complaint, verbatim. */
    this.stderr = options.stderr ?? '';
    /** tar's stdout, verbatim. */
    this.stdout = options.stdout ?? '';
  }
}

/**
 * Did tar fail to START (no binary, no permission) rather than fail at its
 * job? These are the cases where the JSON fallback archiver takes over,
 * because the machine cannot run tar at all.
 *
 * The message patterns are kept for the shape the synchronous caller used to
 * produce (`spawnSync tar EPERM`) and for the shape the tests inject.
 */
export function isTarExecutionError(error) {
  if (!(error instanceof Error)) return false;
  const code = error.code;
  if (typeof code === 'string' && ['EPERM', 'EACCES', 'ENOENT'].includes(code)) return true;
  return /(spawnSync|spawn) tar (EPERM|EACCES)|tar is required/.test(error.message);
}

/**
 * tar's "file changed as we read it" (or "file removed") exit code 1 — a
 * non-fatal warning that the archive WAS still produced (tar tolerates
 * partial reads of changed files). Common when backing up a live data dir
 * while Memphis is running (sqlite WAL flushes, journal block appends,
 * lockfile churn).
 *
 * Returns true if (a) tar exited with status 1 (non-fatal), AND (b) the
 * stderr message contains the file-changed/removed signature, AND (c) the
 * archive file actually exists with non-zero size on disk.
 * In that case the caller can safely treat the backup as successful.
 *
 * Cron task `morning-raport-wodzu` (id task-1777576880613) was failing
 * since 2026-05-01 with this exact pattern blocking the `git-pull-build`
 * pipeline. Fixed 2026-05-08 evening as part of Codex Round 2 follow-up.
 */
export function isTarFileChangedWarning(error, archivePath) {
  if (!(error instanceof Error)) return false;
  const status = typeof error.status === 'number' ? error.status : null;
  if (status !== 1) return false;
  const stderr =
    typeof error.stderr === 'string'
      ? error.stderr
      : error.stderr instanceof Buffer
        ? error.stderr.toString('utf8')
        : '';
  if (!/file changed as we read it|file removed before we read it/.test(stderr)) {
    return false;
  }
  // Verify the archive actually exists and has content
  try {
    const stat = statSync(archivePath);
    return stat.isFile() && stat.size > 0;
  } catch {
    return false;
  }
}

/**
 * tar's own reason, in the message the operator sees.
 *
 * The reason (no space left on device, a killed process, a corrupt member)
 * used to be thrown away, so a broken archive and a broken machine looked
 * identical. MEASURED 2026-11-25 on this host: three consecutive scheduled
 * backups reported a drill failure and not one of them said why.
 */
export function describeTarFailure(error) {
  const err = error instanceof Error ? error : new Error(String(error));
  const stderr =
    typeof err.stderr === 'string'
      ? err.stderr
      : err.stderr instanceof Buffer
        ? err.stderr.toString('utf8')
        : '';
  const reason = stderr
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(0, 3)
    .join(' | ');
  const detail = reason || (err.signal ? `killed by ${err.signal}` : `exit ${err.status}`);
  return new Error(`${err.message} — ${detail}`);
}

function normalizeTarError(error, stdout, stderr) {
  const exitCode = typeof error.code === 'number' ? error.code : null;
  return new TarError(error.message, {
    code: error.code ?? null,
    status: exitCode ?? (typeof error.status === 'number' ? error.status : null),
    signal: error.signal ?? null,
    stderr: typeof stderr === 'string' ? stderr : String(stderr ?? ''),
    stdout: typeof stdout === 'string' ? stdout : String(stdout ?? ''),
  });
}

/**
 * Run tar without blocking the caller's event loop.
 *
 * `LC_ALL=C` for every call: tar's own output is then the same on every
 * host, which matters because the drill reads the verbose listing's first
 * column to refuse links and special files.
 */
export function runTar(args, options = {}) {
  const { maxBuffer = MAX_TAR_LIST_BYTES, env } = options;
  return new Promise((resolve, reject) => {
    execFile(
      'tar',
      args,
      {
        encoding: 'utf8',
        maxBuffer,
        env: env ?? { ...process.env, LC_ALL: 'C' },
      },
      (error, stdout, stderr) => {
        if (!error) {
          resolve({ stdout, stderr });
          return;
        }
        reject(normalizeTarError(error, stdout, stderr));
      },
    );
  });
}

/**
 * tar's stderr is the only thing that says WHY. Dropping it turned five CI
 * rounds into guesswork: the report said `archive-not-listable` and nothing
 * about which flag tar rejected. So it is visible in two places: in the
 * operator's log when the call succeeds, and in the error message when it
 * fails.
 */
function reportTarStderr(stderr) {
  const text = typeof stderr === 'string' ? stderr : String(stderr ?? '');
  if (!text.trim()) return;
  try {
    process.stderr.write(text.endsWith('\n') ? text : `${text}\n`);
  } catch {
    // A closed stderr must not fail the archive.
  }
}

/** The names inside a tar archive. */
export async function tarListArchiveContents(archivePath) {
  const { stdout, stderr } = await runTar(['-tzf', archivePath]);
  reportTarStderr(stderr);
  return stdout
    .split('\n')
    .map((value) => value.trim())
    .filter(Boolean);
}

/**
 * The verbose listing. GNU tar prints the type first, which is how the
 * drill refuses links and special files before it extracts anything.
 */
export async function tarListArchiveVerbose(archivePath) {
  const { stdout, stderr } = await runTar(['-tvzf', archivePath]);
  reportTarStderr(stderr);
  return stdout;
}

/** Write a gzip-compressed tar archive at `archivePath`. */
export async function tarCreateArchive(archivePath, extraArgs = []) {
  const { stderr } = await runTar(['-czf', archivePath, ...extraArgs]);
  reportTarStderr(stderr);
}

/** Extract a gzip-compressed tar archive into `targetRoot`. */
export async function tarExtractArchive(archivePath, targetRoot) {
  const { stderr } = await runTar(['-xzf', archivePath, '-C', targetRoot]);
  reportTarStderr(stderr);
}
