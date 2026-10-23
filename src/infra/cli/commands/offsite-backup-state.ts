import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { getDataDir } from '../../../config/paths.js';

/**
 * The offsite backup state, as the copy step leaves it.
 *
 * The copy step runs from a systemd timer, so nothing about it survives in the
 * daemon's memory. It writes this file instead, and the health payload reads
 * it — because an offsite copy that silently stops is exactly the failure
 * that went unnoticed here for weeks: 58 runs refused to copy and 25 more
 * reported no mount, and `memphis health` described the local backup only.
 *
 * A missing file means the copy step has never run on this host, which is
 * different from a run that failed, and the two are reported differently.
 */

export const OFFSITE_STATE_FILENAME = 'offsite-backup-state.json';

export type OffsiteBackupStatus =
  | 'ok'
  | 'up-to-date'
  | 'no-usb'
  | 'no-archive'
  | 'verify-failed'
  | 'copy-failed'
  | 'unknown';

export interface OffsiteBackupState {
  /** Never ran on this host — no state file has been written yet. */
  status: OffsiteBackupStatus;
  /** Human-readable reason, empty when there is none. */
  detail: string;
  /** ISO timestamp of the last run, null when it has never run. */
  updatedAt: string | null;
  /** Where the drive was mounted, empty when none was found. */
  mount: string;
  /** Name of the archive that is on the drive. */
  archive: string;
  /** Age of that run in milliseconds, null when it has never run. */
  ageMs: number | null;
  /**
   * True when the last run did not leave a usable copy on the drive. A drive
   * that is simply absent counts: that is the case an operator needs to see.
   */
  isStale: boolean;
}

const SUCCESSFUL: readonly OffsiteBackupStatus[] = ['ok', 'up-to-date'];

function isOffsiteStatus(value: unknown): value is OffsiteBackupStatus {
  return (
    typeof value === 'string' &&
    [
      'ok',
      'up-to-date',
      'no-usb',
      'no-archive',
      'verify-failed',
      'copy-failed',
      'unknown',
    ].includes(value)
  );
}

/** Read the state file, if there is one. Never throws. */
export function readOffsiteBackupState(
  dataDir: string = getDataDir(),
  now: number = Date.now(),
): OffsiteBackupState {
  const path = join(dataDir, OFFSITE_STATE_FILENAME);
  if (!existsSync(path)) {
    return {
      status: 'unknown',
      detail: 'the offsite copy step has never run on this host',
      updatedAt: null,
      mount: '',
      archive: '',
      ageMs: null,
      isStale: true,
    };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    return {
      status: 'unknown',
      detail: `offsite state file is unreadable: ${error instanceof Error ? error.message : String(error)}`,
      updatedAt: null,
      mount: '',
      archive: '',
      ageMs: null,
      isStale: true,
    };
  }

  const record = (parsed ?? {}) as Record<string, unknown>;
  const status = isOffsiteStatus(record.status) ? record.status : 'unknown';
  const updatedAt = typeof record.updatedAt === 'string' ? record.updatedAt : null;
  const parsedTime = updatedAt ? Date.parse(updatedAt) : Number.NaN;
  const ageMs = Number.isFinite(parsedTime) ? Math.max(0, now - parsedTime) : null;

  return {
    status,
    detail: typeof record.detail === 'string' ? record.detail : '',
    updatedAt,
    mount: typeof record.mount === 'string' ? record.mount : '',
    archive: typeof record.archive === 'string' ? record.archive : '',
    ageMs,
    // A successful run still goes stale once the drive stops being copied to.
    // Four hours is the timer interval, so a run older than that means the
    // copy step has not run since — which is the case worth surfacing.
    isStale: !SUCCESSFUL.includes(status) || ageMs === null || ageMs > 4 * 60 * 60 * 1000,
  };
}
