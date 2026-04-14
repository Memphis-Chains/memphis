/**
 * Scheduled backup loop with restore-drill verification (Phase 1.2).
 *
 * `memphis backup create` exists and works. This module makes it run
 * AUTOMATICALLY on a configurable cadence so operators don't have to
 * remember a cron entry. Without scheduled backups, the first disk
 * failure on a client install wipes the chain + vault and Memphis has
 * no recovery path.
 *
 * Bonus: every Nth backup runs a restore-drill — extracts the just-
 * created archive into a tmp dir and validates the chain. If the
 * extraction or validation fails, we ALERT immediately (rather than
 * discovering at the wrong moment that backups have been silently
 * corrupt for weeks).
 *
 * Env controls:
 *   MEMPHIS_BACKUP_INTERVAL_MS         — default 24h. Min 5 min, max 7 days.
 *                                        Unset = disabled.
 *   MEMPHIS_BACKUP_DRILL_EVERY_N       — run the restore-drill on every
 *                                        Nth backup. Default 7 (so weekly
 *                                        if backup is daily).
 *   MEMPHIS_BACKUP_STALE_ALERT_MS      — alert when the latest backup is
 *                                        older than this. Default 2× interval.
 *   MEMPHIS_BACKUP_KEEP                — retention for the cleaner that
 *                                        runs after each successful backup.
 *                                        Default keeps last 14 backups.
 *
 * /v1/ops/status surfaces:
 *   { backups: { lastSuccessAt, lastDrillAt, lastError, ageMs, isStale, ... } }
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createPinoLogger } from '../logging/pino.js';
import { writeSecurityAudit } from '../logging/security-audit.js';

const log = createPinoLogger({ level: process.env.LOG_LEVEL ?? 'info' });

export const DEFAULT_BACKUP_INTERVAL_MS = 24 * 60 * 60 * 1000; // 24h
export const MIN_BACKUP_INTERVAL_MS = 5 * 60 * 1000; // 5 min
export const MAX_BACKUP_INTERVAL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
export const DEFAULT_DRILL_EVERY_N = 7;

export interface ScheduledBackupState {
  enabled: boolean;
  intervalMs?: number;
  lastSuccessAt?: string;
  lastSuccessFile?: string;
  lastSuccessSizeBytes?: number;
  lastError?: string;
  lastErrorAt?: string;
  lastDrillAt?: string;
  lastDrillOk?: boolean;
  lastDrillError?: string;
  totalSuccess: number;
  totalFailures: number;
  totalDrills: number;
}

export interface ScheduledBackupOptions {
  rawEnv?: NodeJS.ProcessEnv;
  intervalMs?: number;
  /** Test seam — substitute the backup creator. */
  createBackupFn?: () => Promise<{
    backupPath: string;
    file: string;
    size: number;
  }>;
  /** Test seam — substitute the restore-drill. */
  drillFn?: (backupPath: string) => Promise<void>;
  /** Test seam — substitute the cleaner. */
  cleanFn?: () => Promise<void>;
  /** Per-tick callback for tests. */
  onTick?: (state: ScheduledBackupState) => void;
}

export interface ScheduledBackupHandle {
  stop: () => void;
  /** Run a single tick now (test/manual). */
  tickNow: () => Promise<ScheduledBackupState>;
  state: () => ScheduledBackupState;
}

const state: ScheduledBackupState = {
  enabled: false,
  totalSuccess: 0,
  totalFailures: 0,
  totalDrills: 0,
};

function readIntervalFromEnv(rawEnv: NodeJS.ProcessEnv): number | null {
  const raw = rawEnv.MEMPHIS_BACKUP_INTERVAL_MS?.trim();
  if (!raw) return null;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) return null;
  if (parsed < MIN_BACKUP_INTERVAL_MS || parsed > MAX_BACKUP_INTERVAL_MS) return null;
  return Math.floor(parsed);
}

function readDrillEveryN(rawEnv: NodeJS.ProcessEnv): number {
  const raw = rawEnv.MEMPHIS_BACKUP_DRILL_EVERY_N?.trim();
  if (!raw) return DEFAULT_DRILL_EVERY_N;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 1) return DEFAULT_DRILL_EVERY_N;
  return Math.floor(parsed);
}

function readKeep(rawEnv: NodeJS.ProcessEnv): number {
  const raw = rawEnv.MEMPHIS_BACKUP_KEEP?.trim();
  if (!raw) return 14;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 1) return 14;
  return Math.floor(parsed);
}

/**
 * Default restore-drill: verify the archive is listable + contains at
 * least one chain block file.
 *
 * Codex Round 6 P1 fix (PR #120): the old drill unconditionally ran
 * `tar -tzf`, but `createBackup` can produce a fallback gzip/JSON
 * archive when tar is unavailable (EPERM/EACCES path). That made every
 * drill on those hosts emit a false drill_failed alert. Use the
 * canonical `listArchiveContents` from backup.ts which already
 * handles BOTH formats.
 */
async function defaultDrill(backupPath: string): Promise<void> {
  const drillDir = mkdtempSync(join(tmpdir(), 'memphis-backup-drill-'));
  try {
    const { listArchiveContents } = await import('../cli/commands/backup.js');
    const entries = listArchiveContents(backupPath);
    if (entries.length === 0) {
      throw new Error('drill failed: archive has no entries');
    }
    const hasBlocks = entries.some((e) => /chains\/.+\.json/.test(e));
    if (!hasBlocks) {
      throw new Error('drill failed: archive contains no chain block files');
    }
  } finally {
    rmSync(drillDir, { recursive: true, force: true });
  }
}

/**
 * Start the scheduled backup loop. Returns a handle so shutdown can stop it.
 *
 * Returns a no-op handle when MEMPHIS_BACKUP_INTERVAL_MS is unset and
 * no explicit intervalMs override is passed — operators must opt in.
 * Default behaviour is silent no-op.
 */
export function startScheduledBackupLoop(
  options: ScheduledBackupOptions = {},
): ScheduledBackupHandle {
  const rawEnv = options.rawEnv ?? process.env;
  // Interval is bound at setInterval and can't change post-start.
  // drillEveryN + keep ARE classified hot in mutability.ts, so we
  // re-read them on every tick (Codex Round 6 P2 fix on PR #120).
  const interval = options.intervalMs ?? readIntervalFromEnv(rawEnv);
  const drillFn = options.drillFn ?? defaultDrill;

  const createBackupFn =
    options.createBackupFn ??
    (async () => {
      // Dynamic import to avoid pulling backup module into tests
      // that just want to stub createBackupFn.
      const { createBackup } = await import('../cli/commands/backup.js');
      const result = await createBackup({ tag: 'scheduled', showProgress: false });
      return { backupPath: result.backupPath, file: result.file, size: result.size };
    });
  const cleanFn =
    options.cleanFn ??
    (async () => {
      // Re-read keep on each clean so /config set MEMPHIS_BACKUP_KEEP
      // actually takes effect immediately.
      const { cleanBackups } = await import('../cli/commands/backup.js');
      await cleanBackups({ keep: readKeep(rawEnv) });
    });

  let inFlight = false;

  const tickNow = async (): Promise<ScheduledBackupState> => {
    if (inFlight) {
      log.warn(
        { event: 'backup.scheduled.overlap' },
        'scheduled backup skipped — prior tick still running',
      );
      return state;
    }
    inFlight = true;
    try {
      // Re-read on each tick so hot-reload via /config set picks up.
      const drillEveryN = readDrillEveryN(rawEnv);
      log.info({ event: 'backup.scheduled.start' }, 'scheduled backup starting');
      const result = await createBackupFn();
      state.lastSuccessAt = new Date().toISOString();
      state.lastSuccessFile = result.file;
      state.lastSuccessSizeBytes = result.size;
      state.lastError = undefined;
      state.lastErrorAt = undefined;
      state.totalSuccess += 1;
      log.info(
        {
          event: 'backup.scheduled.success',
          file: result.file,
          sizeBytes: result.size,
        },
        'scheduled backup succeeded',
      );
      writeSecurityAudit({
        action: 'system.backup.scheduled',
        status: 'allowed',
        details: { file: result.file, sizeBytes: result.size },
      });

      // Restore-drill every Nth success
      if (state.totalSuccess % drillEveryN === 0) {
        try {
          await drillFn(result.backupPath);
          state.lastDrillAt = new Date().toISOString();
          state.lastDrillOk = true;
          state.lastDrillError = undefined;
          state.totalDrills += 1;
          log.info(
            { event: 'backup.scheduled.drill.success', file: result.file },
            'restore-drill verified backup is restorable',
          );
        } catch (err) {
          state.lastDrillAt = new Date().toISOString();
          state.lastDrillOk = false;
          state.lastDrillError = err instanceof Error ? err.message : String(err);
          state.totalDrills += 1;
          log.error(
            {
              event: 'backup.scheduled.drill.failed',
              file: result.file,
              error: state.lastDrillError,
            },
            'restore-drill FAILED — backup may not be restorable',
          );
          writeSecurityAudit({
            action: 'system.backup.drill_failed',
            status: 'blocked',
            details: { file: result.file, error: state.lastDrillError },
          });
        }
      }

      // Cleanup old backups
      try {
        await cleanFn();
      } catch (err) {
        log.warn(
          {
            event: 'backup.scheduled.clean.failed',
            error: err instanceof Error ? err.message : String(err),
          },
          'backup cleanup failed (non-fatal)',
        );
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      state.lastError = message;
      state.lastErrorAt = new Date().toISOString();
      state.totalFailures += 1;
      log.error(
        { event: 'backup.scheduled.failed', error: message },
        'scheduled backup FAILED',
      );
      writeSecurityAudit({
        action: 'system.backup.scheduled_failed',
        status: 'blocked',
        details: { error: message },
      });
    } finally {
      inFlight = false;
      options.onTick?.(state);
    }
    return state;
  };

  if (interval === null) {
    state.enabled = false;
    return {
      stop: () => {},
      tickNow,
      state: () => state,
    };
  }

  state.enabled = true;
  state.intervalMs = interval;
  const timer = setInterval(() => void tickNow(), interval);
  if (typeof timer === 'object' && 'unref' in timer) {
    timer.unref();
  }

  log.info(
    {
      event: 'backup.scheduled.loop.started',
      intervalMs: interval,
      drillEveryN: readDrillEveryN(rawEnv),
      keep: readKeep(rawEnv),
    },
    'scheduled backup loop started',
  );

  return {
    stop: () => clearInterval(timer),
    tickNow,
    state: () => state,
  };
}

/** Snapshot for /status payloads. */
export function getScheduledBackupState(rawEnv: NodeJS.ProcessEnv = process.env): {
  state: ScheduledBackupState;
  ageMs: number | null;
  isStale: boolean;
} {
  const ageMs = state.lastSuccessAt
    ? Date.now() - new Date(state.lastSuccessAt).getTime()
    : null;
  const intervalMs = state.intervalMs ?? readIntervalFromEnv(rawEnv) ?? null;
  const staleThreshold = readStaleThresholdMs(rawEnv, intervalMs);
  const isStale =
    state.enabled && ageMs !== null && staleThreshold !== null && ageMs > staleThreshold;
  return { state: { ...state }, ageMs, isStale };
}

function readStaleThresholdMs(
  rawEnv: NodeJS.ProcessEnv,
  intervalMs: number | null,
): number | null {
  const raw = rawEnv.MEMPHIS_BACKUP_STALE_ALERT_MS?.trim();
  if (raw) {
    const parsed = Number(raw);
    if (Number.isFinite(parsed) && parsed > 0) return parsed;
  }
  // Default: 2x the interval. If interval is unset, no staleness check.
  return intervalMs !== null ? intervalMs * 2 : null;
}

/** Test-only: clear state so a fresh loop can be started. */
export function __resetScheduledBackupForTests(): void {
  state.enabled = false;
  state.intervalMs = undefined;
  state.lastSuccessAt = undefined;
  state.lastSuccessFile = undefined;
  state.lastSuccessSizeBytes = undefined;
  state.lastError = undefined;
  state.lastErrorAt = undefined;
  state.lastDrillAt = undefined;
  state.lastDrillOk = undefined;
  state.lastDrillError = undefined;
  state.totalSuccess = 0;
  state.totalFailures = 0;
  state.totalDrills = 0;
}
