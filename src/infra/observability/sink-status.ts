/**
 * Status file contract for the local span sinks.
 *
 * WHY THIS EXISTS
 * ---------------
 * Measured on this host (2026-10-29): the `tool.call` spans stopped on
 * 2026-10-26 — the day the operator moved from the Telegram gateway to
 * the Rust TUI — and the SLO report said "no tool.call spans in window"
 * for days. The reason was invisible: the sink had failed once and then
 * stayed silent for the rest of the process lifetime.
 *
 * A sink that is broken and a runtime that is idle look identical from
 * the outside — both produce no spans. This file is how the two are told
 * apart: a sink that failed says so, in a place the report reads.
 *
 * WHERE THE FILE LIVES
 * --------------------
 * In the DATA directory, not in `telemetry/`. The span file and the
 * status file fail for different reasons: a span write dies when the
 * telemetry directory is unwritable or the disk is full, and the status
 * file has to survive exactly that case. One level up is the most
 * survivable place we have.
 *
 * The TypeScript gateway and the native Rust arm write SEPARATE files
 * (`sink-status-ts.json`, `sink-status-rust.json`) because they are
 * separate processes writing into the same directory: one file would be
 * overwritten by the other and the operator would read whichever
 * process wrote last.
 *
 * The shape is a contract between two implementations in two languages.
 * `tests/fixtures/telemetry-sink-status-contract.json` holds the field
 * list; the TypeScript and Rust suites both check their writer against
 * it, so the arms cannot drift apart silently.
 */

import { readdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';

/** File name pattern of a sink status file, e.g. `sink-status-ts.json`. */
export const SINK_STATUS_FILE_RE = /^sink-status-(.+)\.json$/;

/** The surface a sink belongs to. Free-form, because the arms differ. */
export type SinkSurface = string;

/** `degraded` means the last write failed; `ok` means it recovered. */
export type SinkState = 'ok' | 'degraded';

export interface SinkStatusEntry {
  /** Which writer produced this file: `ts` for the gateway, `rust` for the native arm. */
  surface: SinkSurface;
  /** `degraded` while the sink cannot write, `ok` after it recovers. */
  state: SinkState;
  /** How many consecutive write attempts failed. Reset to 0 on recovery. */
  consecutiveFailures: number;
  /** The last write error, verbatim, or null when the sink is healthy. */
  lastError: string | null;
  /** ISO timestamp of the last failed write, or null. */
  lastFailureAt: string | null;
  /** ISO timestamp of the last successful write, or null. */
  lastSuccessAt: string | null;
  /** ISO timestamp of the next write attempt, while degraded. Null when healthy. */
  nextRetryAt: string | null;
  /** ISO timestamp of the moment this file was written. */
  updatedAt: string;
}

/** The file name a given surface writes its status to. */
export function sinkStatusFileName(surface: SinkSurface): string {
  return `sink-status-${surface}.json`;
}

/**
 * Write a sink status file.
 *
 * The write goes to a temporary file and is then renamed, so a reader
 * never sees a half-written JSON document. Best effort by design: the
 * caller is already handling a broken sink, and a status file that
 * cannot be written must not throw.
 */
export function writeSinkStatus(dir: string, entry: SinkStatusEntry): void {
  const target = path.join(dir, sinkStatusFileName(entry.surface));
  const tmp = `${target}.tmp-${process.pid}`;
  writeFileSync(tmp, `${JSON.stringify(entry, null, 2)}\n`, {
    encoding: 'utf8',
    mode: 0o600,
  });
  renameSync(tmp, target);
}

/**
 * Read every sink status file in a data directory.
 *
 * A file that is unreadable or malformed is skipped rather than thrown:
 * a broken status file must not break the report that reads it.
 */
export function readSinkStatusEntries(dir: string): SinkStatusEntry[] {
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }
  const entries: SinkStatusEntry[] = [];
  for (const name of names) {
    const match = SINK_STATUS_FILE_RE.exec(name);
    if (!match) continue;
    try {
      const parsed = JSON.parse(readFileSync(path.join(dir, name), 'utf8')) as SinkStatusEntry;
      if (typeof parsed?.surface !== 'string' || typeof parsed?.state !== 'string') continue;
      entries.push(parsed);
    } catch {
      continue;
    }
  }
  return entries;
}
