/**
 * Turns the runtime still believes are running.
 *
 * WHY THIS IS NOT A SPAN
 * ----------------------
 * The SLO report is built from telemetry spans, and spans cannot see a
 * hang: `turn.dispatch` is written AFTER the turn returns
 * (crates/memphis-operator/src/chat.rs — `turn_elapsed` is measured at
 * the end of `run_turn`). A turn that never finishes therefore writes
 * NO `turn.dispatch` span at all.
 *
 * Measured 2026-11-11: the 18-hour-old leftover turn on this host
 * wrote zero spans of any kind, so every span-based metric was blind
 * to it — while the runtime refused to start a new turn in that
 * session ("a turn is active or was interrupted unexpectedly").
 *
 * The runtime's own answer to "is a turn still running?" lives in the
 * operator database: `operator_turn_checkpoints` holds one row per
 * turn, `status='running'` while the turn is in flight. The row's
 * `updated_at` is refreshed after every assistant step and after every
 * tool result (chat.rs: `save_turn_checkpoint(..., "running", ...)`),
 * so its age is the time since the turn last made progress.
 *
 * WHY THE IDLE BOUND IS TWO HOURS
 * -------------------------------
 * `updated_at` also ages while a single long tool call runs, because
 * the checkpoint is written after that tool returns. The longest
 * `tool.call` measured on this host is 3 600 266 ms (~1 hour), so a
 * bound below that would report a healthy long build as a stuck turn.
 * Two hours is above the longest measured single step with room to
 * spare; raise it with `MEMPHIS_SLO_STUCK_TURN_AGE_MS`.
 */

import { existsSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';

import Database from 'better-sqlite3';

import { resolveInstallRoot } from '../infra/runtime/install-root.js';

/** Default: the time without progress after which a turn counts as stuck. */
export const DEFAULT_STUCK_TURN_AGE_MS = 2 * 60 * 60 * 1000;

/** One turn the runtime still considers running. */
export interface RunningTurn {
  id: string;
  sessionId: string;
  /** When the turn last made progress. */
  updatedAt: string;
  /** Milliseconds since that progress. */
  idleMs: number;
}

export type RunningTurnsResult = { ok: true; turns: RunningTurn[] } | { ok: false; reason: string };

/**
 * Where the operator database lives.
 *
 * `DATABASE_URL` is a `file:` URL. The TypeScript recovery command
 * resolves a relative path against the install root
 * (src/infra/cli/handlers/recovery.handler.ts), and this resolves it
 * the same way — resolving against the current working directory would
 * point at a different file depending on where the command was
 * started.
 */
export function resolveOperatorDatabasePath(
  rawEnv: NodeJS.ProcessEnv = process.env,
): string | null {
  const url = rawEnv.DATABASE_URL?.trim() || 'file:./data/memphis.db';
  if (!url.startsWith('file:')) return null;
  const file = url.slice('file:'.length).trim();
  if (!file) return null;
  return isAbsolute(file) ? file : resolve(resolveInstallRoot({ rawEnv }), file);
}

/**
 * Read the turns the runtime still considers running.
 *
 * Read-only: this is a measurement, and it must never write to the
 * operator's database.
 */
export function readRunningTurns(
  databasePath: string,
  nowMs: number = Date.now(),
): RunningTurnsResult {
  if (!existsSync(databasePath)) {
    // The database is where the runtime records which turn is in
    // flight. Without it the question cannot be answered at all — and
    // missing evidence is not a pass.
    return {
      ok: false,
      reason: `no operator database at ${databasePath} — cannot tell whether a turn is stuck`,
    };
  }
  let db: Database.Database;
  try {
    db = new Database(databasePath, { readonly: true, fileMustExist: true });
    // The operator database is in WAL mode and the native arm writes to
    // it while we read it. Without a busy timeout a read that lands
    // during a write returns SQLITE_BUSY and the metric would report
    // "unreadable" for a database that is perfectly readable.
    db.pragma('busy_timeout = 1000');
  } catch (error) {
    return { ok: false, reason: `operator database unreadable: ${(error as Error).message}` };
  }
  try {
    const table = db
      .prepare(
        "SELECT 1 FROM sqlite_master WHERE type='table' AND name='operator_turn_checkpoints'",
      )
      .get();
    // The checkpoint table is missing. It is created together with the
    // chat tables when the first turn runs, so its absence means either
    // that no turn ever ran OR that this is not the database the runtime
    // uses — a path split. Measured 2026-11-11: the stale copy of the
    // operator database on this host has no checkpoint table at all.
    //
    // Reporting a real zero here would turn a path split into a green
    // light over a stuck turn. Missing evidence is not a pass.
    if (!table) {
      return {
        ok: false,
        reason: `no turn checkpoint table in ${databasePath} — cannot tell whether a turn is stuck`,
      };
    }
    const rows = db
      .prepare(
        "SELECT id, session_id AS sessionId, updated_at AS updatedAt FROM operator_turn_checkpoints WHERE status='running'",
      )
      .all() as Array<{ id: string; sessionId: string; updatedAt: string }>;
    const turns: RunningTurn[] = [];
    for (const row of rows) {
      const updatedMs = Date.parse(row.updatedAt);
      if (!Number.isFinite(updatedMs)) continue;
      turns.push({
        id: row.id,
        sessionId: row.sessionId,
        updatedAt: row.updatedAt,
        idleMs: Math.max(0, nowMs - updatedMs),
      });
    }
    turns.sort((a, b) => b.idleMs - a.idleMs);
    return { ok: true, turns };
  } catch (error) {
    return { ok: false, reason: `operator database unreadable: ${(error as Error).message}` };
  } finally {
    db.close();
  }
}
