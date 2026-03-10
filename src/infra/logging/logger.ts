export type LogLevel = 'debug' | 'info' | 'warn' | 'error';
export type LogFormat = 'text' | 'json';

type LogContext = Record<string, unknown>;
type LogWriter = (line: string) => void;

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
      context: (second && typeof second === 'object' ? (second as LogContext) : {}),
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
    context: (second && typeof second === 'object' ? (second as LogContext) : {}),
  };
}

function formatContextValue(value: unknown): string {
  if (value === null) return 'null';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
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
  debug: (...args: unknown[]) => void;
  info: (...args: unknown[]) => void;
  warn: (...args: unknown[]) => void;
  error: (...args: unknown[]) => void;
  trace: (...args: unknown[]) => void;
  fatal: (...args: unknown[]) => void;
  silent: (...args: unknown[]) => void;
  child: (bindings: LogContext) => AppLogger;
};

export function createLogger(
  level: LogLevel = 'info',
  format: LogFormat = 'text',
  bindings: LogContext = {},
  write: LogWriter = (line) => process.stdout.write(`${line}\n`),
): AppLogger {
  const threshold = LEVEL_PRIORITY[level];

  const emit = (entryLevel: LogLevel, args: unknown[]) => {
    if (LEVEL_PRIORITY[entryLevel] < threshold) return;

    const { message, context } = normalizeArgs(args);
    const mergedContext = { ...bindings, ...context };
    const line = format === 'json'
      ? formatJsonLine(entryLevel, message, mergedContext)
      : formatTextLine(entryLevel, message, mergedContext);

    write(line);
  };

  return {
    level,
    debug: (...args: unknown[]) => emit('debug', args),
    info: (...args: unknown[]) => emit('info', args),
    warn: (...args: unknown[]) => emit('warn', args),
    error: (...args: unknown[]) => emit('error', args),
    trace: (...args: unknown[]) => emit('debug', args),
    fatal: (...args: unknown[]) => emit('error', args),
    silent: () => {},
    child: (childBindings: LogContext) => createLogger(level, format, { ...bindings, ...childBindings }, write),
  };
}
