import pino, { type Logger, type LoggerOptions } from 'pino';

export function createPinoLogger(options?: LoggerOptions): Logger {
  return pino(
    options ?? {},
    pino.destination({
      dest: 2,
      sync: process.env.NODE_ENV === 'test',
    }),
  );
}
