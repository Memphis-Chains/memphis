import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

import pino, { type DestinationStream, type Logger, type LoggerOptions } from 'pino';

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
  if (fileStream) {
    const multistream = pino.multistream([
      { stream: stderrStream },
      { stream: fileStream, level: (options?.level as string) ?? 'info' },
    ]);
    return pino(options ?? {}, multistream);
  }

  return pino(options ?? {}, stderrStream);
}
