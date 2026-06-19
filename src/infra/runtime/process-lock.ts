/**
 * Singleton process lock — prevents two Memphis runtimes from sharing the
 * same data dir.
 *
 * P3 hotfix (Phase 1.3): the 2026-05-08 runtime diagnostic surfaced two
 * Memphis processes (pid 12618 + 14230) both started the Telegram channel
 * gateway. Concurrent writers race on chains, vault state, and journal —
 * silent persistence corruption. Symptom-only fixes don't help; the only
 * structural cure is an OS-level lock acquired at boot, refused if held.
 *
 * Design:
 *   - PID file at `<dataDir>/memphis.pid`. Written atomically with `wx`
 *     (exclusive create — fails if file exists).
 *   - On startup, attempt to acquire. If the file exists, read the holder
 *     PID and probe `process.kill(holder, 0)`. If the holder is alive →
 *     refuse start. If the holder is dead (stale PID file) → take over by
 *     overwriting the file.
 *   - Release on graceful exit (process.on('exit', release)). Signal
 *     handlers (SIGTERM/SIGINT) call release explicitly before exit.
 *
 * Note on `flock(2)` vs PID file: a PID file is portable (works on
 * Linux/macOS/Windows) and survives crashes (we explicitly probe for
 * staleness). flock(2) gives stronger atomicity but needs platform-
 * specific code (LockFileEx on Windows). We pick the portable path.
 *
 * Caller contract: invoke `acquireProcessLock()` BEFORE any side-effecting
 * boot work (provider registry, channel gateway, scheduler). On refusal
 * (`acquired: false`), exit with code 13.
 */

import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, openSync, readFileSync, unlinkSync, writeSync, closeSync } from 'node:fs';
import { dirname } from 'node:path';

export interface ProcessLockHandle {
  acquired: boolean;
  /** PID of the current holder. When `acquired === true`, this is `process.pid`. */
  holder: number;
  /**
   * When `acquired === false`, an operator-actionable hint describing how to
   * recover (typically `memphis stop` or `memphis kill-zombies`).
   */
  hint?: string;
  release: () => void;
}

const NOOP = () => undefined;

function isPidAlive(pid: number): boolean {
  try {
    // Sending signal 0 doesn't deliver anything but lets us probe whether
    // the PID exists and we have permission to signal it. ESRCH = dead.
    process.kill(pid, 0);
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ESRCH') {
      return isSystemdUserMainPid(pid);
    }
    if ((err as NodeJS.ErrnoException).code === 'EPERM') {
      // Permission denied — process exists but we can't signal it. Treat
      // as alive (safer to refuse than to overwrite a foreign process's
      // PID file).
      return true;
    }
    return false;
  }
}

function isSystemdUserMainPid(pid: number): boolean {
  try {
    const status = spawnSync(
      'systemctl',
      ['--user', 'show', 'memphis.service', '-p', 'MainPID', '-p', 'ActiveState', '--value'],
      { encoding: 'utf8', timeout: 1000 },
    );
    if (status.status !== 0) return false;
    const [mainPidRaw, activeStateRaw] = status.stdout
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);
    const mainPid = Number.parseInt(mainPidRaw ?? '', 10);
    return mainPid === pid && activeStateRaw === 'active';
  } catch {
    return false;
  }
}

function readHolder(lockPath: string): number | null {
  try {
    const raw = readFileSync(lockPath, 'utf8').trim();
    const pid = Number.parseInt(raw, 10);
    if (!Number.isFinite(pid) || pid <= 0) return null;
    return pid;
  } catch {
    return null;
  }
}

function writeAtomicLock(lockPath: string, pid: number): boolean {
  // wx = exclusive create. If file exists, throws EEXIST and we know
  // another holder is candidate.
  try {
    const fd = openSync(lockPath, 'wx');
    try {
      writeSync(fd, `${pid}\n`);
    } finally {
      closeSync(fd);
    }
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'EEXIST') return false;
    throw err;
  }
}

export function lockPathFor(dataDir: string): string {
  return `${dataDir}/memphis.pid`;
}

export function acquireProcessLock(options: { dataDir: string }): ProcessLockHandle {
  const lockPath = lockPathFor(options.dataDir);
  mkdirSync(dirname(lockPath), { recursive: true });

  // Fast path — atomic create succeeds.
  if (writeAtomicLock(lockPath, process.pid)) {
    return makeHandle(lockPath, process.pid);
  }

  // Slow path — file exists. Determine if holder is alive.
  const holder = readHolder(lockPath);
  if (holder !== null && isPidAlive(holder)) {
    return {
      acquired: false,
      holder,
      hint:
        `Another Memphis instance is running (pid ${holder}). ` +
        `Stop it first: 'memphis stop' (graceful) or 'memphis stop --force' (SIGKILL).`,
      release: NOOP,
    };
  }

  // Stale lock — owner is dead. Take over by overwriting.
  // Race window: another process could acquire between unlink and re-create,
  // but we're already in a "PID file says X but X is dead" state — practical
  // impact is one wasted boot attempt by the loser.
  try {
    unlinkSync(lockPath);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      // Permission or fs issue — treat as locked.
      return {
        acquired: false,
        holder: holder ?? -1,
        hint:
          `Lock file ${lockPath} cannot be cleaned: ${err instanceof Error ? err.message : String(err)}. ` +
          `Inspect it manually.`,
        release: NOOP,
      };
    }
  }

  if (writeAtomicLock(lockPath, process.pid)) {
    return makeHandle(lockPath, process.pid, /* tookOver */ true);
  }

  // Lost the race after stale cleanup.
  const newHolder = readHolder(lockPath) ?? -1;
  return {
    acquired: false,
    holder: newHolder,
    hint: `Race during stale-lock takeover. Retry boot.`,
    release: NOOP,
  };
}

function makeHandle(lockPath: string, pid: number, tookOver = false): ProcessLockHandle {
  let released = false;
  const release = (): void => {
    if (released) return;
    released = true;
    try {
      // Only delete if WE still own it. Reading the file before delete
      // avoids removing someone else's lock if our own process was killed
      // and a new one took over.
      const current = readHolder(lockPath);
      if (current === pid) {
        unlinkSync(lockPath);
      }
    } catch {
      // best-effort
    }
  };

  // Caller (bootstrap.ts) is responsible for wiring shutdown handlers.
  // We deliberately don't `process.on('exit', release)` here: vitest
  // workers crashed in CI when the auto-attached handler ran during
  // worker teardown (each test acquired+released, but the registered
  // listener accumulated and fired during worker exit). Bootstrap and
  // serve.ts call release explicitly on SIGTERM/SIGINT.
  return {
    acquired: true,
    holder: pid,
    hint: tookOver ? 'Took over a stale lock from a dead process.' : undefined,
    release,
  };
}

/**
 * Read the current lock holder without acquiring. Used by `memphis stop`
 * and the doctor "Process" row.
 */
export function peekProcessLock(dataDir: string): {
  holder: number | null;
  alive: boolean;
  lockPath: string;
} {
  const lockPath = lockPathFor(dataDir);
  if (!existsSync(lockPath)) return { holder: null, alive: false, lockPath };
  const holder = readHolder(lockPath);
  return {
    holder,
    alive: holder !== null && isPidAlive(holder),
    lockPath,
  };
}
