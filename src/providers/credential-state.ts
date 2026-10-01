/**
 * Provider credential-state classification.
 *
 * Separates "a key exists in the environment" from "a key that is
 * plausibly real". This exists because every `isAvailable()` in this
 * codebase is a tautology over `isConfigured()` (see journal-633 for
 * the audit), which made `/v1/providers/health` report `ok: true` for
 * a provider whose key was the literal string `sk-test`.
 *
 * Nothing here performs I/O. A `present` classification is a statement
 * about the environment, not about the remote endpoint — verifying
 * that would cost a round trip per provider on every health poll, and
 * several providers rate-limit unauthenticated probes.
 */

import type { ProviderCredentialState } from '../core/types.js';

/**
 * Scaffold values that ship in `.env.example`, in test fixtures, and
 * in hand-written `.env` files. A credential equal to one of these is
 * never usable: they exist to make the config file parse, not to
 * authenticate.
 *
 * Kept deliberately small and exact rather than heuristic. A fuzzy
 * "looks like a test key" regex would misclassify real keys that happen
 * to contain a substring, and the cost of that (an operator's working
 * provider dropped from the cascade) is much higher than the cost of
 * missing an unusual placeholder.
 */
const PLACEHOLDER_VALUES: ReadonlySet<string> = new Set([
  // Anthropic-style scaffold.
  'sk-test',
  'sk-test-key',
  'sk-ant-test',
  // Generic scaffolding.
  'test',
  'testing',
  'placeholder',
  'changeme',
  'change-me',
  'your-key-here',
  'your_api_key_here',
  'xxx',
  'xxxx',
  'xxxxx',
  'todo',
  // Sometimes left by a half-finished setup.
  'none',
  'null',
  'undefined',
]);

function normaliseForComparison(value: string): string {
  return value.trim().toLowerCase();
}

/**
 * Classifies a raw credential value.
 *
 * - `missing`    — empty or whitespace-only. `isConfigured()` is false
 *                  for these, so the provider is never registered and
 *                  there is no ambiguity to resolve.
 * - `placeholder` — a known scaffold value, including the literal
 *                  strings `none` / `null` / `undefined` that some
 *                  editors substitute when clearing a field. These are
 *                  deliberately *not* folded into `missing`: they are
 *                  non-empty, so `isConfigured()` returns true and the
 *                  provider registers with a key that cannot work.
 *                  Folding them in would reproduce the exact blindness
 *                  this module is fixing.
 * - `present`     — anything else. Says nothing about validity.
 */
export function classifyCredentialValue(
  value: string | undefined | null,
): ProviderCredentialState {
  if (value === undefined || value === null) return 'missing';

  const trimmed = value.trim();
  if (trimmed.length === 0) return 'missing';

  const normalised = normaliseForComparison(trimmed);
  if (PLACEHOLDER_VALUES.has(normalised)) return 'placeholder';

  return 'present';
}

/**
 * Classifies a resolved provider credential.
 *
 * `undefined` means the resolution path found nothing (no vault entry,
 * no plaintext). An empty string is treated the same way — both mean
 * "this provider cannot authenticate", and both previously produced
 * `ok: true` on the health endpoint whenever the surrounding adapter's
 * `isConfigured()` happened to look at a different variable.
 */
export function classifyProviderCredential(
  resolvedKey: string | undefined,
): ProviderCredentialState {
  return classifyCredentialValue(resolvedKey);
}

/**
 * Human-readable explanation for `/providers` and the TUI status line.
 * Kept here rather than in the route so the TUI and HTTP surfaces
 * describe the same state in the same words.
 */
export function describeCredentialState(state: ProviderCredentialState): string {
  switch (state) {
    case 'missing':
      return 'no credential configured — provider is not registered';
    case 'placeholder':
      return 'credential is a known placeholder value and will be rejected by the provider';
    case 'present':
      return 'credential present (not verified against the provider endpoint)';
  }
}
