import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

import pino, { type DestinationStream, type Logger, type LoggerOptions } from 'pino';

/**
 * Registry of every Pino logger created via `createPinoLogger` so that a
 * `LOG_LEVEL` post-apply hook can walk them and update each one's `.level`
 * property. Without this, the level is captured by closure at construction
 * and `/v1/ops/config/reload` had no effect on existing loggers (Sprint 12
 * deferral; closed in the "all 8 deferred items" run).
 */
const liveLoggers = new Set<WeakRef<Logger>>();
const loggerRegistry = new FinalizationRegistry<WeakRef<Logger>>((ref) => {
  liveLoggers.delete(ref);
});

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
    const multistream = pino.multistream([
      { stream: stderrStream },
      { stream: fileStream, level: (options?.level as string) ?? 'info' },
    ]);
    logger = pino(options ?? {}, multistream);
  } else {
    logger = pino(options ?? {}, stderrStream);
  }

  const ref = new WeakRef(logger);
  liveLoggers.add(ref);
  loggerRegistry.register(logger, ref);
  return logger;
}

/**
 * Update the level on every live Pino logger. Pino's `.level` setter
 * propagates to child loggers that haven't overridden their own level,
 * so most short-lived per-request loggers pick up the new value
 * automatically; module-scope singletons get the explicit walk.
 */
export function setAllPinoLoggerLevels(level: string): { updated: number } {
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
  return { updated };
}

/** Test-only: clear the registry (does not destroy the loggers themselves). */
export function __resetPinoRegistryForTests(): void {
  liveLoggers.clear();
}
