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

import { createPinoLogger } from './pino.js';

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
    level: process.env.LOG_LEVEL ?? 'info',
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
export function withContext(
  logger: ContextLogger,
  context: LogContext,
): ContextLogger {
  const cleaned: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(context)) {
    if (value !== undefined && value !== null && value !== '') {
      cleaned[key] = value;
    }
  }
  return logger.child(cleaned);
}
