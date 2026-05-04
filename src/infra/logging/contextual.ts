/**
 * Contextual logger helpers for Sprint 10 observability.
 *
 * A contextual logger is a Pino child logger that carries well-known fields —
 * `requestId`, `surface`, `actorId`, `turnId` — so every log line produced
 * during one request or turn can be correlated across layers.
 *
 * Usage at HTTP boundary:
 *     const log = createContextualLogger({ requestId, route });
 *     log.info({ event: 'turn.start' }, 'processing turn');
 *
 * Usage deep in the call tree (pass the logger rather than importing a new
 * one; that way structured fields propagate):
 *     function handleTool(log: ContextLogger) { log.info(...); }
 */

import type { Logger } from 'pino';

import { setAllAppLoggerLevels } from './logger.js';
import { createPinoLogger, setAllPinoLoggerLevels } from './pino.js';
import { LOG_LEVEL } from '../../config/env-registry.js';
import { registerPostApplyHook } from '../config/post-apply-hooks.js';

export interface LogContext {
  requestId?: string;
  surface?: string;
  actorId?: string;
  turnId?: string;
  route?: string;
  [extra: string]: unknown;
}

export type ContextLogger = Logger;

let rootLogger: ContextLogger | null = null;

function getRootLogger(): ContextLogger {
  if (rootLogger) return rootLogger;
  rootLogger = createPinoLogger({
    level: LOG_LEVEL.read(process.env),
    base: undefined,
  });
  return rootLogger;
}

/** Reset the cached root logger — for tests, not for production code. */
export function resetRootLogger(): void {
  rootLogger = null;
}

/**
 * Create a child logger that carries the supplied context fields.
 * Undefined fields are stripped so the log line stays compact.
 */
export function createContextualLogger(context: LogContext = {}): ContextLogger {
  const cleaned: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(context)) {
    if (value !== undefined && value !== null && value !== '') {
      cleaned[key] = value;
    }
  }
  return getRootLogger().child(cleaned);
}

/** Extend an existing contextual logger with more fields without resetting. */
export function withContext(logger: ContextLogger, context: LogContext): ContextLogger {
  const cleaned: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(context)) {
    if (value !== undefined && value !== null && value !== '') {
      cleaned[key] = value;
    }
  }
  return logger.child(cleaned);
}

/**
 * Hot-swap LOG_LEVEL — closes the longstanding deferral. The post-apply
 * hook walks both logger registries (Pino + AppLogger) so a `/config set
 * LOG_LEVEL debug` followed by `/v1/ops/config/reload` actually changes
 * the threshold on every live logger, including the cached module-scope
 * singletons. Default value (when env unset) is 'info' to match the
 * envSchema default.
 */
const VALID_LOG_LEVELS = new Set(['debug', 'info', 'warn', 'error']);

registerPostApplyHook('LOG_LEVEL', 'logger.setAllLevels', (ctx) => {
  const raw = (ctx.nextValue ?? 'info').trim().toLowerCase();
  const level = VALID_LOG_LEVELS.has(raw) ? (raw as 'debug' | 'info' | 'warn' | 'error') : 'info';
  // Reset the cached root so subsequent `createContextualLogger` calls
  // get a logger constructed at the new level.
  if (rootLogger) {
    try {
      rootLogger.level = level;
    } catch {
      // unknown level — already coerced above, but be defensive
    }
  }
  setAllPinoLoggerLevels(level);
  setAllAppLoggerLevels(level);
});
