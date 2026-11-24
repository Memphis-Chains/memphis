/**
 * The chain-name vocabulary — GENERATED, do not edit.
 *
 * Projected from the Rust core's owner
 * (`crates/memphis-paths/src/chain_names.rs`) by
 * `scripts/sync-chain-name-contract.mts`. Regenerate with:
 *
 * ```bash
 * npm run -s ops:sync-chain-name-contract
 * ```
 *
 * The PATTERNS are the vocabulary; the FUNCTIONS that use them live in
 * `src/memory/chain-catalog.ts`. Both sides are checked against the
 * artefact of cases (`tests/fixtures/chain-name-contract.json`), so
 * neither this mirror nor the Rust owner can drift from the other
 * without a gate saying so.
 */
export const PLAIN_CHAIN_NAME_PATTERN = '^[A-Za-z0-9_-]{1,64}$';

export const MAX_CHAIN_NAME_LENGTH = 64;

export const ARCHIVE_CHAIN_PART_PATTERN = '^[A-Za-z0-9_-]+$';

export const ARCHIVE_SEPARATOR = '.backup-';

export const ARCHIVE_STAMP_PATTERNS = [
  '^[0-9]+$',
  '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}-[0-9]{2}-[0-9]{2}-[0-9]{3}Z$',
] as const;

export const CHAIN_NAME_ALIASES = {
  case: 'cases',
  decision: 'decisions',
  pattern: 'patterns',
  reflection: 'reflections',
} as const;

export type ChainNameAlias = keyof typeof CHAIN_NAME_ALIASES;
