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
    sharedFileStream = pino.destination({ dest: logPath, sync: false, mkdir: true });
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
