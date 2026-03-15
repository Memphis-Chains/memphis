export const EXIT_CODES = {
  SUCCESS: 0,
  ERR_GENERAL: 1,
  ERR_HARDENING: 101,
  ERR_CORRUPTION: 102,
  ERR_TRUST_ROOT: 103,
} as const;

export type ExitCode = (typeof EXIT_CODES)[keyof typeof EXIT_CODES];

export class MemphisExitError extends Error {
  public readonly exitCode: ExitCode;

  constructor(exitCode: ExitCode, message: string, cause?: unknown) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = 'MemphisExitError';
    this.exitCode = exitCode;
  }
}

export function resolveExitCode(error: unknown): ExitCode {
  if (error instanceof MemphisExitError) {
    return error.exitCode;
  }
  return EXIT_CODES.ERR_GENERAL;
}
