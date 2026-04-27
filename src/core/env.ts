/**
 * Shared environment variable utilities.
 *
 * Centralizes parseBool to eliminate duplication across 11+ files.
 */

/**
 * Parse a string environment variable as a boolean.
 *
 * Accepts the conventional truthy/falsy strings:
 *   truthy: "true", "1", "yes", "on" (case-insensitive)
 *   falsy:  "false", "0", "no", "off" (case-insensitive)
 * Returns `fallback` for undefined or unrecognized values.
 *
 * Why the broad set: error messages across the codebase (e.g. the vault
 * re-init guard's "set MEMPHIS_VAULT_FORCE_REINIT=1") instruct operators
 * to use `=1`. Previously parseBool only accepted `"true"`, so the
 * documented workaround failed silently — operator's 2026-04-27 trace
 * showed `MEMPHIS_VAULT_FORCE_REINIT=1 memphis vault init` re-throw the
 * same VaultAlreadyInitializedError despite the flag. The error message
 * and the parser must agree.
 */
const TRUTHY_VALUES = new Set(['true', '1', 'yes', 'on']);
const FALSY_VALUES = new Set(['false', '0', 'no', 'off']);

export function parseBool(value: string | undefined, fallback = true): boolean {
  if (typeof value !== 'string') return fallback;
  const normalized = value.trim().toLowerCase();
  if (TRUTHY_VALUES.has(normalized)) return true;
  if (FALSY_VALUES.has(normalized)) return false;
  return fallback;
}
