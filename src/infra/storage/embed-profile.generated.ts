/**
 * The embed-profile vocabulary — GENERATED, do not edit.
 *
 * Projected from the Rust owner's manifest
 * (`crates/memphis-embed/src/profile.rs`) by
 * `scripts/sync-embed-profile-contract.mts`. Regenerate with:
 *
 * ```bash
 * npm run -s ops:sync-embed-profile-contract
 * ```
 *
 * WHAT THIS IS
 * ------------
 * The NAMES and the DEFAULTS of the embedding profile — the environment
 * variables it reads, the order its dimension sources are consulted in, the
 * verdicts it can report, the provider names its mode accepts, and the width
 * of the local deterministic embedder.
 *
 * It is NOT the rule itself. The rule lives in the owner and is asked
 * through the bridge (`src/infra/storage/rust-embed-profile-bridge.ts`),
 * so this side never decides which index is read or how wide it is. What
 * this side must not do is carry its OWN copy of the names — the copy that
 * made a process answer dim 32 while the service answered 1024.
 *
 * The local width is the LAST resort: it is what the local deterministic
 * embedder produces, and it is only reached when there is no index on disk
 * to contradict it. A provider's own width is never guessed from a name.
 */
export const EMBED_PROFILE_ENV = {
  indexPath: 'RUST_EMBED_PERSIST_PATH',
  dimension: 'RUST_EMBED_DIM',
  model: 'RUST_EMBED_PROVIDER_MODEL',
  mode: 'RUST_EMBED_MODE',
} as const;

/** The dimension sources, in the order the owner consults them. */
export const EMBED_PROFILE_DIMENSION_SOURCES = [
  'env',
  'index',
  'local-deterministic',
] as const;

/** The verdicts the owner can report. */
export const EMBED_PROFILE_VERDICTS = [
  'ok',
  'no-provider',
  'no-index',
  'dimension-mismatch',
] as const;

/** The mode word that means "no provider". */
export const EMBED_PROFILE_LOCAL_MODE = 'local';

/** The mode word that means "the OpenAI-compatible provider". */
export const EMBED_PROFILE_PROVIDER_ALIAS = 'provider';

/** The provider names the mode accepts. */
export const EMBED_PROFILE_PROVIDER_MODES = [
  'openai-compatible',
  'ollama',
  'cohere',
  'voyage',
  'jina',
  'mistral',
  'together',
  'nvidia',
  'mixedbread',
] as const;

/** The width of the local deterministic embedder — the LAST resort. */
export const EMBED_PROFILE_LOCAL_DIMENSION = 32;

/** Where the index lives when the environment does not name one. */
export const EMBED_PROFILE_DEFAULT_INDEX_PATH = '<data_dir>/embed/index-v1.json';

export type EmbedProfileVerdict = (typeof EMBED_PROFILE_VERDICTS)[number];
export type EmbedProfileDimensionSource = (typeof EMBED_PROFILE_DIMENSION_SOURCES)[number];
