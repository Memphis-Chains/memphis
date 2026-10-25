const IO_ERROR_CODES = new Set([
  'ENOSPC',
  'EACCES',
  'EPERM',
  'EIO',
  'EROFS',
  'EMFILE',
  'ENFILE',
  'ENOENT',
  'ENOTDIR',
  'EISDIR',
  'EEXIST',
  'EINVAL',
  'EBUSY',
  'EBADF',
]);

/** Only closed OS codes may cross an I/O diagnostic boundary. */
export function safeIoErrorCode(error: unknown): string | undefined {
  try {
    const code =
      error && typeof error === 'object'
        ? Object.getOwnPropertyDescriptor(error, 'code')?.value
        : undefined;
    if (typeof code === 'string' && IO_ERROR_CODES.has(code)) return code;
  } catch {
    /* A proxy/getter must not make error reporting throw. */
  }
  return undefined;
}
