export type LogLevel = 'debug' | 'info' | 'warn' | 'error';
export type LogFormat = 'text' | 'json';

type LogContext = Record<string, unknown>;
type LogWriter = (line: string) => void;
const DEFAULT_WRITE: LogWriter = (line) => process.stderr.write(`${line}\n`);

const LEVEL_PRIORITY: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

function normalizeArgs(args: unknown[]): { message: string; context: LogContext } {
  if (args.length === 0) return { message: '', context: {} };

  const [first, second] = args;

  if (typeof first === 'string') {
    return {
      message: first,
      context: second && typeof second === 'object' ? (second as LogContext) : {},
    };
  }

  if (first && typeof first === 'object') {
    return {
      message: typeof second === 'string' ? second : '',
      context: first as LogContext,
    };
  }

  return {
    message: String(first),
    context: second && typeof second === 'object' ? (second as LogContext) : {},
  };
}

function serializeHttpObject(value: unknown): string | null {
  if (!value || typeof value !== 'object') return null;
  const obj = value as Record<string, unknown>;

  // Fastify request object
  if ('method' in obj && 'url' in obj && 'hostname' in obj) {
    const parts = [`method=${obj.method}`, `url=${obj.url}`];
    if (obj.hostname) parts.push(`hostname=${obj.hostname}`);
    if (obj.remoteAddress) parts.push(`remoteAddress=${obj.remoteAddress}`);
    return parts.join(' ');
  }

  // Fastify reply object
  if ('statusCode' in obj && typeof obj.statusCode === 'number') {
    return `statusCode=${obj.statusCode}`;
  }

  return null;
}

function formatContextValue(value: unknown): string {
  if (value === null) return 'null';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  const httpSerialized = serializeHttpObject(value);
  if (httpSerialized) return httpSerialized;
  try {
    return JSON.stringify(value);
  } catch {
    return '[unserializable]';
  }
}

function formatTextLine(level: LogLevel, message: string, context: LogContext): string {
  const timestamp = new Date().toISOString();
  const suffix = Object.entries(context)
    .map(([key, value]) => `${key}=${formatContextValue(value)}`)
    .join(' ');

  const base = `${timestamp} [${level.toUpperCase()}] ${message}`.trimEnd();
  return suffix ? `${base} ${suffix}` : base;
}

function formatJsonLine(level: LogLevel, message: string, context: LogContext): string {
  return JSON.stringify({
    timestamp: new Date().toISOString(),
    level,
    message,
    context,
  });
}

export type AppLogger = {
  level: LogLevel;
  setLevel: (newLevel: LogLevel) => void;
  debug: (...args: unknown[]) => void;
  info: (...args: unknown[]) => void;
  warn: (...args: unknown[]) => void;
  error: (...args: unknown[]) => void;
  trace: (...args: unknown[]) => void;
  fatal: (...args: unknown[]) => void;
  silent: (...args: unknown[]) => void;
  child: (bindings: LogContext) => AppLogger;
};

/**
 * Registry of every AppLogger created via `createLogger` so the LOG_LEVEL
 * post-apply hook can update each one's threshold without restart. Mirror
 * of the Pino registry in `pino.ts`.
 */
const liveAppLoggers = new Set<WeakRef<AppLogger>>();
const appLoggerRegistry = new FinalizationRegistry<WeakRef<AppLogger>>((ref) => {
  liveAppLoggers.delete(ref);
});

export function createLogger(
  level: LogLevel = 'info',
  format: LogFormat = 'text',
  bindings: LogContext = {},
  write: LogWriter = DEFAULT_WRITE,
): AppLogger {
  // Holder pattern: the threshold is read fresh on each emit so setLevel
  // takes effect immediately without rebuilding closures.
  const state = { level, threshold: LEVEL_PRIORITY[level] };
  const quietTestLogs =
    process.env.NODE_ENV === 'test' &&
    process.env.MEMPHIS_QUIET_TEST_LOGS === '1' &&
    write === DEFAULT_WRITE;

  const emit = (entryLevel: LogLevel, args: unknown[]) => {
    if (quietTestLogs) return;
    if (LEVEL_PRIORITY[entryLevel] < state.threshold) return;

    const { message, context } = normalizeArgs(args);
    const mergedContext = { ...bindings, ...context };
    const line =
      format === 'json'
        ? formatJsonLine(entryLevel, message, mergedContext)
        : formatTextLine(entryLevel, message, mergedContext);

    write(line);
  };

  const logger: AppLogger = {
    get level() {
      return state.level;
    },
    set level(newLevel: LogLevel) {
      state.level = newLevel;
      state.threshold = LEVEL_PRIORITY[newLevel];
    },
    setLevel(newLevel: LogLevel) {
      state.level = newLevel;
      state.threshold = LEVEL_PRIORITY[newLevel];
    },
    debug: (...args: unknown[]) => emit('debug', args),
    info: (...args: unknown[]) => emit('info', args),
    warn: (...args: unknown[]) => emit('warn', args),
    error: (...args: unknown[]) => emit('error', args),
    trace: (...args: unknown[]) => emit('debug', args),
    fatal: (...args: unknown[]) => emit('error', args),
    silent: () => {},
    child: (childBindings: LogContext) =>
      createLogger(state.level, format, { ...bindings, ...childBindings }, write),
  };

  const ref = new WeakRef(logger);
  liveAppLoggers.add(ref);
  appLoggerRegistry.register(logger, ref);
  return logger;
}

/**
 * Update the level on every live AppLogger. Returns count of loggers
 * affected so the post-apply hook can include it in the audit/result.
 */
export function setAllAppLoggerLevels(level: LogLevel): { updated: number } {
  let updated = 0;
  for (const ref of liveAppLoggers) {
    const logger = ref.deref();
    if (!logger) {
      liveAppLoggers.delete(ref);
      continue;
    }
    logger.setLevel(level);
    updated += 1;
  }
  return { updated };
}

/** Test-only: clear the registry (does not destroy the loggers themselves). */
export function __resetAppLoggerRegistryForTests(): void {
  liveAppLoggers.clear();
}
