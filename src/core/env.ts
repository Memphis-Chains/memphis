/**
 * Shared environment variable utilities.
 *
 * Centralizes parseBool to eliminate duplication across 11+ files.
 */

/**
 * Parse a string environment variable as a boolean.
 * Returns `fallback` if the value is undefined or not a recognized boolean string.
 */
export function parseBool(value: string | undefined, fallback = true): boolean {
  if (typeof value !== 'string') return fallback;
  return value.trim().toLowerCase() === 'true';
}
