/**
 * Security-focused Unicode normalization helpers.
 *
 * We normalize user-controlled strings to NFC before validation so visually
 * identical inputs that use different Unicode composition forms are treated
 * consistently.
 */

const FALLBACK_EMPTY = '';

export function normalizeToNfc(input: unknown): string {
  if (typeof input !== 'string') return FALLBACK_EMPTY;
  return input.normalize('NFC');
}

export function trimAndNormalizeToNfc(input: unknown): string {
  return normalizeToNfc(input).trim();
}
