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
 *     record and probe whether that exact process is still alive. If it is
 *     alive → refuse start. If it is dead (stale PID file) → take over by
 *     overwriting the file.
 *   - Release on graceful exit (process.on('exit', release)). Signal
 *     handlers (SIGTERM/SIGINT) call release explicitly before exit.
 *
 * 2026-10-23 incident — the PID alone was not an identity:
 *   The file stored only a PID, and "is this PID alive?" was answered with
 *   `process.kill(pid, 0)`. After a reboot the kernel hands out the same
 *   numbers again, so a stale PID file pointed at an unrelated live
 *   process and the daemon refused to start with "Another Memphis instance
 *   is running (pid 790)" — where 790 was uwsm's signal-handler shell.
 *   The daemon was dead in the water until the lock was removed by hand.
 *
 *   The lock now records the process IDENTITY, not just its number:
 *     - `pid`      — the process ID
 *     - `bootId`   — the kernel's boot ID (`/proc/sys/kernel/random/boot_id`)
 *     - `startTime`— the process start time in clock ticks since boot
 *                    (`/proc/<pid>/stat`, field 22)
 *   A holder is alive only when the PID exists AND the boot ID still
 *   matches AND the start time is unchanged. PID recycling across a reboot
 *   is caught by the boot ID; recycling within one boot is caught by the
 *   start time. Together they identify a process exactly.
 *
 *   The file format is a JSON object. A bare number is still accepted on
 *   read, so a lock file written by an older build is treated as a legacy
 *   record and probed with the old PID-only rule — those files are
 *   short-lived (one boot) and self-heal on the next successful start.
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
import {
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  unlinkSync,
  writeSync,
  closeSync,
} from 'node:fs';
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

/**
 * Identity of a running process, as recorded in the lock file.
 *
 * `bootId` distinguishes processes across reboots; `startTime` distinguishes
 * processes within one boot. Both are needed: a PID is only unique within a
 * single boot, and a start time is only meaningful within a single boot.
 */
interface ProcessIdentity {
  pid: number;
  bootId: string;
  startTime: number;
}

/** Read the kernel boot identity on Linux and macOS. */
function readBootId(): string {
  if (process.platform === 'darwin') {
    const result = spawnSync('/usr/sbin/sysctl', ['-n', 'kern.bootsessionuuid'], {
      encoding: 'utf8',
      timeout: 1000,
    });
    return result.status === 0 ? result.stdout.trim() : '';
  }
  try {
    return readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim();
  } catch {
    return '';
  }
}

/**
 * Read a process's start time in clock ticks since boot.
 *
 * Field 22 of `/proc/<pid>/stat`. The `comm` field (field 2) may itself
 * contain spaces and parentheses, so the fields after it are located from the
 * LAST ')' in the line rather than by splitting the whole line.
 */
function readProcessStartTime(pid: number): number | undefined {
  if (process.platform === 'darwin') {
    // BSD ps exposes an absolute start time, stable across repeated probes.
    // Force the locale so Date.parse does not depend on the operator's language.
    const result = spawnSync('/bin/ps', ['-p', String(pid), '-o', 'lstart='], {
      encoding: 'utf8',
      timeout: 1000,
      env: { ...process.env, LC_ALL: 'C' },
    });
    const value = result.status === 0 ? Date.parse(result.stdout.trim()) : NaN;
    return Number.isFinite(value) ? value : undefined;
  }
  try {
    const raw = readFileSync(`/proc/${pid}/stat`, 'utf8');
    const close = raw.lastIndexOf(')');
    if (close === -1) return undefined;
    // Fields after `comm` start at field 3 (state) => starttime is field 22.
    const afterComm = raw.slice(close + 2).split(' ');
    const value = Number.parseInt(afterComm[19] ?? '', 10);
    return Number.isFinite(value) ? value : undefined;
  } catch {
    return undefined;
  }
}

/** Identity of the process running this code, for writing the lock file. */
function currentIdentity(): ProcessIdentity {
  return {
    pid: process.pid,
    bootId: readBootId(),
    startTime: readProcessStartTime(process.pid) ?? 0,
  };
}

/**
 * Decide whether a recorded holder is still the same live process.
 *
 * The PID being alive is necessary but NOT sufficient: after a reboot the
 * kernel reuses numbers, and an unrelated process may hold the recorded PID.
 * The boot ID catches that, and the start time catches reuse within a boot.
 */
function identityIsAlive(identity: ProcessIdentity): boolean {
  if (!Number.isFinite(identity.pid) || identity.pid <= 0) return false;

  // Signal 0 delivers nothing but proves the PID exists and is ours to
  // signal. ESRCH = dead.
  try {
    process.kill(identity.pid, 0);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ESRCH') {
      // The PID is gone — but systemd may still consider the service alive
      // while it is between restarts. Fall through to the systemd check.
      if (!isSystemdUserMainPid(identity.pid)) return false;
    } else if (code === 'EPERM') {
      // Permission denied — the process exists but we cannot signal it.
      // Treat as alive (safer to refuse than to overwrite a foreign
      // process's lock).
      return true;
    } else {
      return false;
    }
  }

  // From here the PID exists. A recorded boot ID that no longer matches
  // means the machine rebooted and this PID was handed to another process.
  if (identity.bootId) {
    const currentBootId = readBootId();
    if (currentBootId && currentBootId !== identity.bootId) return false;
  }

  // A recorded start time that differs means the PID was recycled within
  // this boot — a different process now holds the number.
  if (identity.startTime > 0) {
    const currentStartTime = readProcessStartTime(identity.pid);
    if (currentStartTime !== undefined && currentStartTime !== identity.startTime) return false;
  }

  return true;
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

/**
 * Read the holder record from the lock file.
 *
 * Two formats are accepted:
 *   - JSON object with `pid`, optional `bootId`, optional `startTime`
 *   - a bare number (legacy format, written by builds before 2026-10-23)
 *
 * A legacy record carries no identity, so it cannot be verified: the PID may
 * have been reused by an unrelated process since the file was written. The
 * PID-only probe is exactly the rule that left the daemon dead in the water
 * after the 2026-10-23 reboot, so a legacy record is treated as UNVERIFIABLE
 * rather than as a live holder. Such files live for at most one boot cycle.
 */
function readHolderRecord(lockPath: string): ProcessIdentity | null {
  let raw: string;
  try {
    raw = readFileSync(lockPath, 'utf8').trim();
  } catch {
    return null;
  }
  if (!raw) return null;

  if (raw.startsWith('{')) {
    try {
      const parsed = JSON.parse(raw) as Record<string, unknown>;
      const pid = Number.parseInt(String(parsed.pid ?? ''), 10);
      if (!Number.isFinite(pid) || pid <= 0) return null;
      const bootId = typeof parsed.bootId === 'string' ? parsed.bootId : '';
      const startTime = Number.parseInt(String(parsed.startTime ?? ''), 10);
      return {
        pid,
        bootId,
        startTime: Number.isFinite(startTime) ? startTime : 0,
      };
    } catch {
      return null;
    }
  }

  // Legacy: a bare PID on its own line.
  const pid = Number.parseInt(raw, 10);
  if (!Number.isFinite(pid) || pid <= 0) return null;
  return { pid, bootId: '', startTime: 0 };
}

function readHolder(lockPath: string): number | null {
  return readHolderRecord(lockPath)?.pid ?? null;
}

/**
 * Liveness of a recorded holder, with three possible answers.
 *
 * `live`       — the recorded identity is verifiably the same running process
 * `stale`      — the recorded process is provably gone or provably different
 * `unverifiable`— the record carries no identity, so it cannot be trusted
 */
type HolderLiveness = 'live' | 'stale' | 'unverifiable';

function classifyHolder(holder: ProcessIdentity | null): HolderLiveness {
  if (holder === null) return 'stale';
  // No boot ID and no start time: written by an older build. The PID alone
  // cannot distinguish "the daemon is running" from "the kernel reused this
  // number for something else", and guessing wrong keeps the daemon down.
  if (!holder.bootId && holder.startTime <= 0) return 'unverifiable';
  return identityIsAlive(holder) ? 'live' : 'stale';
}

function writeAtomicLock(lockPath: string, identity: ProcessIdentity): boolean {
  // wx = exclusive create. If file exists, throws EEXIST and we know
  // another holder is candidate.
  try {
    const fd = openSync(lockPath, 'wx');
    try {
      writeSync(fd, `${JSON.stringify(identity)}\n`);
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

  const identity = currentIdentity();

  // Fast path — atomic create succeeds.
  if (writeAtomicLock(lockPath, identity)) {
    return makeHandle(lockPath, identity, /* tookOver */ false);
  }

  // Slow path — file exists. Determine if holder is alive.
  const holder = readHolderRecord(lockPath);
  const liveness = classifyHolder(holder);

  if (liveness === 'live' && holder !== null) {
    return {
      acquired: false,
      holder: holder.pid,
      hint:
        `Another Memphis instance is running (pid ${holder.pid}). ` +
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
        holder: holder?.pid ?? -1,
        hint:
          `Lock file ${lockPath} cannot be cleaned: ${err instanceof Error ? err.message : String(err)}. ` +
          `Inspect it manually.`,
        release: NOOP,
      };
    }
  }

  if (writeAtomicLock(lockPath, identity)) {
    return makeHandle(lockPath, identity, /* tookOver */ true);
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

function makeHandle(
  lockPath: string,
  identity: ProcessIdentity,
  tookOver = false,
): ProcessLockHandle {
  let released = false;
  const release = (): void => {
    if (released) return;
    released = true;
    try {
      // Only delete if WE still own it. Reading the file before delete
      // avoids removing someone else's lock if our own process was killed
      // and a new one took over.
      const current = readHolder(lockPath);
      if (current === identity.pid) {
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
    holder: identity.pid,
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
  const holder = readHolderRecord(lockPath);
  if (holder === null) return { holder: null, alive: false, lockPath };
  // A record without identity cannot be confirmed alive, so it is reported
  // as not alive — the daemon may then reclaim it.
  const alive = classifyHolder(holder) === 'live';
  return { holder: holder.pid, alive, lockPath };
}
