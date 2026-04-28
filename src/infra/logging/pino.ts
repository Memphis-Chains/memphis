import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

import pino, { type DestinationStream, type Logger, type LoggerOptions } from 'pino';

import { maybeRotateLogFile } from './log-rotation.js';

/**
 * Registry of every Pino logger created via `createPinoLogger` so that a
 * `LOG_LEVEL` post-apply hook can walk them and update each one's `.level`
 * property. Without this, the level is captured by closure at construction
 * and `/v1/ops/config/reload` had no effect on existing loggers.
 *
 * Codex Round 5 P2 fix: we ALSO track the multistream destinations so
 * the per-stream `level` filters baked into pino.multistream entries get
 * updated. Without this, lowering LOG_LEVEL at runtime (warn → debug)
 * left the file sink at the old threshold and silently dropped log
 * lines even though the in-memory hook reported success.
 */
const liveLoggers = new Set<WeakRef<Logger>>();
const loggerRegistry = new FinalizationRegistry<WeakRef<Logger>>((ref) => {
  liveLoggers.delete(ref);
});

// Each entry is the streams array returned by pino.multistream — mutating
// `.level` on each element propagates to the per-stream filter on the
// next emit.
//
// Codex Round 6 P2 (PR #118): the old code wrapped each MultistreamEntry
// in a WeakRef with no strong retention anywhere else, so the entry
// could be garbage-collected while the logger was still alive. That
// silently killed file-stream level updates in long-running processes
// after a GC cycle. Fix: hold the entry strongly in a WeakMap keyed by
// the Logger itself — the entry is reachable as long as the logger is,
// and garbage-collects together with it.
interface MultistreamEntry {
  streams: Array<{ level?: string | number; stream: DestinationStream }>;
}
const multistreamByLogger = new WeakMap<Logger, MultistreamEntry>();

/**
 * Sprint 2.3 — track every pino destination so the graceful-shutdown
 * sequence can flushSync them before exitFn(). Without this, sonic-boom
 * destinations created with `sync: false` (default for stderr in
 * production) hold pending log lines in memory at SIGTERM and the
 * post-exit V8 teardown lands them on an FD already invalidated —
 * one of the SEGV-on-shutdown causes flagged in #270.
 *
 * Strong references intentionally: streams are process-lifetime
 * resources; if the operator drops a logger we still want to flush
 * any buffered lines on shutdown rather than lose audit data.
 */
const allDestinations = new Set<DestinationStream>();

/**
 * Resolve the local log file path.
 * Set MEMPHIS_LOG_FILE to override (default: ~/.memphis/logs/memphis.log).
 * Set MEMPHIS_LOG_FILE=none to disable file logging.
 */
function resolveLogFilePath(): string | null {
  const explicit = process.env.MEMPHIS_LOG_FILE?.trim();
  if (explicit === 'none') return null;
  if (explicit) return explicit;

  const home = process.env.HOME ?? process.env.USERPROFILE ?? '/tmp';
  const logDir = join(home, '.memphis', 'logs');
  try {
    mkdirSync(logDir, { recursive: true });
  } catch {
    // best-effort
  }
  return join(logDir, 'memphis.log');
}

let sharedFileStream: DestinationStream | null | undefined;

function getFileStream(): DestinationStream | null {
  if (sharedFileStream !== undefined) return sharedFileStream;
  const logPath = resolveLogFilePath();
  if (!logPath) {
    sharedFileStream = null;
    return null;
  }
  try {
    // Rotate before opening the destination so a single long-lived
    // process doesn't grow memphis.log unboundedly across restarts.
    // sonic-boom holds an open FD; pre-open rotation guarantees the
    // new process writes to a fresh file.
    maybeRotateLogFile(logPath);
  } catch {
    // best-effort: rotation failure must never block logger startup
  }
  try {
    // sync: true uses sync open + sync writes, removing the
    // "sonic boom is not ready yet" race that surfaces as
    // `[memphis] uncaught exception` on rapid back-to-back service
    // restarts. The throughput cost for a CLI/daemon writing a few
    // hundred lines per second is negligible; the race-on-startup is
    // the bigger problem because the lost log lines are exactly the
    // boot-time diagnostics operators need to debug crashes.
    sharedFileStream = pino.destination({ dest: logPath, sync: true, mkdir: true });
    allDestinations.add(sharedFileStream);
    return sharedFileStream;
  } catch {
    sharedFileStream = null;
    return null;
  }
}

export function createPinoLogger(options?: LoggerOptions): Logger {
  const fileStream = getFileStream();
  const stderrStream = pino.destination({
    dest: 2,
    sync: process.env.NODE_ENV === 'test',
  });
  allDestinations.add(stderrStream);

  // If file logging is available, use multistream (stderr + file)
  let logger: Logger;
  if (fileStream) {
    const initialLevel = (options?.level as string) ?? 'info';
    // We hold the streams array in a typed local so we can mutate per-entry
    // levels later via setAllPinoLoggerLevels.
    const streamsArray: MultistreamEntry['streams'] = [
      { stream: stderrStream, level: initialLevel },
      { stream: fileStream, level: initialLevel },
    ];
    const multistream = pino.multistream(streamsArray);
    logger = pino(options ?? {}, multistream);
    multistreamByLogger.set(logger, { streams: streamsArray });
  } else {
    logger = pino(options ?? {}, stderrStream);
  }

  const ref = new WeakRef(logger);
  liveLoggers.add(ref);
  loggerRegistry.register(logger, ref);
  return logger;
}

/**
 * Update the level on every live Pino logger AND every live multistream
 * entry. Pino's `.level` setter propagates to child loggers that haven't
 * overridden their own level; the per-stream filter in multistream is
 * baked at creation, so we update those entries' `.level` directly.
 *
 * Codex Round 5 P2 fix: without the multistream walk, lowering the
 * level (warn → debug) at runtime left the file sink filtering at warn,
 * silently dropping the lines the operator just asked to see.
 */
export function setAllPinoLoggerLevels(level: string): {
  updated: number;
  multistreamsUpdated: number;
} {
  let updated = 0;
  for (const ref of liveLoggers) {
    const logger = ref.deref();
    if (!logger) {
      liveLoggers.delete(ref);
      continue;
    }
    try {
      logger.level = level;
      updated += 1;
    } catch {
      // pino throws on unknown levels — best-effort, skip and continue
    }
  }
  // Walk the logger registry and look each one up in the multistream
  // WeakMap. Since the entry is strongly referenced FROM the logger
  // (via the WeakMap), it can't be GC'd independently — the Codex
  // Round 6 P2 failure mode.
  let multistreamsUpdated = 0;
  for (const ref of liveLoggers) {
    const logger = ref.deref();
    if (!logger) continue;
    const entry = multistreamByLogger.get(logger);
    if (!entry) continue;
    for (const streamEntry of entry.streams) {
      streamEntry.level = level;
    }
    multistreamsUpdated += 1;
  }
  return { updated, multistreamsUpdated };
}

/** Test-only: clear the registry (does not destroy the loggers themselves). */
export function __resetPinoRegistryForTests(): void {
  liveLoggers.clear();
  // multistreamByLogger is a WeakMap — entries auto-clear when loggers GC
}

/**
 * Sprint 2.3 — synchronously flush every tracked pino destination.
 * Called from graceful-shutdown.ts AFTER `embed_shutdown()` and BEFORE
 * `exitFn()`, so any buffered log lines (sonic-boom async destinations,
 * stderr in production) hit disk before V8 tears down the FDs.
 *
 * Failure-tolerant: a per-stream flush error is counted and skipped;
 * the remaining streams still get drained. Returns counts so the
 * shutdown sequence can audit the outcome ("flushed=3 errors=0").
 *
 * Pino destinations expose `flushSync()` (sonic-boom). Streams that
 * don't (custom transports) are silently skipped — no-ops on the
 * unrecognised shape.
 */
export function flushAllPinoStreamsSync(): { flushed: number; errors: number } {
  let flushed = 0;
  let errors = 0;
  for (const stream of allDestinations) {
    const flushFn = (stream as { flushSync?: () => void }).flushSync;
    if (typeof flushFn !== 'function') continue;
    try {
      flushFn.call(stream);
      flushed += 1;
    } catch {
      errors += 1;
    }
  }
  return { flushed, errors };
}
