/**
 * Security: Sanitizers for untrusted external data
 * Defense against prompt injection, ANSI escape injection, log injection
 */

/**
 * Strip ANSI escape sequences and control characters
 * Prevents terminal control sequence injection
 */
export function sanitizeForTerminal(input: string): string {
  return (
    input
      // eslint-disable-next-line no-control-regex
      .replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '') // CSI sequences
      // eslint-disable-next-line no-control-regex
      .replace(/\x1b\][^\x07]*\x07/g, '') // OSC sequences (match until BEL)
      // eslint-disable-next-line no-control-regex
      .replace(/\x1b[PX^_]/g, '') // DCS, SOS, PM, APC
      // Remove other control characters except \n, \t, \r
      // eslint-disable-next-line no-control-regex
      .replace(/[\x00-\x08\x0B-\x0C\x0E-\x1F\x7F]/g, '')
      // Limit to reasonable length (prevent DoS)
      .slice(0, 1000)
  );
}

/**
 * Sanitize for single-line log output
 * Prevents log injection via newlines
 */
export function sanitizeForLog(input: string): string {
  return sanitizeForTerminal(input)
    .replace(/[\r\n]/g, ' ') // Convert newlines to spaces
    .trim();
}

/**
 * Validate provider name against allowlist pattern
 * Prevents path traversal and injection
 */
export function validateProviderName(name: string): boolean {
  // Allow: alphanumeric, dash, underscore only
  // Max length: 50 chars
  return /^[a-zA-Z0-9_-]{1,50}$/.test(name);
}

/**
 * Sanitize degradation reason for safe display
 * Combines terminal safety + length limit
 */
export function sanitizeDegradationReason(reason: string): string {
  const safe = sanitizeForTerminal(reason);
  // Truncate with ellipsis if too long
  return safe.length > 200
    ? safe.slice(0, 197) + '...'
    : safe;
}

/**
 * Sanitize for JSON response (HTTP)
 * Ensures valid Unicode, no control chars except whitespace
 */
export function sanitizeForJson(input: string): string {
  return (
    input
      // eslint-disable-next-line no-control-regex
      .replace(/[\x00-\x1F\x7F]/g, '') // Remove all control chars
      .replace(/\uFFFD/g, '') // Remove replacement characters
      .slice(0, 1000)
  );
}
