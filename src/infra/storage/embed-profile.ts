/**
 * The embed profile, as the TypeScript surfaces see it.
 *
 * THE RULE IS NOT HERE
 * --------------------
 * This module does not decide which index is read, how wide its vectors
 * are, or whether a provider is available. It asks the owner — the Rust
 * crate `crates/memphis-embed/src/profile.rs`, through the bridge — and
 * hands the answer on.
 *
 * WHY IT MATTERS
 * --------------
 * "Which embedding profile is in force?" had FOUR answers on this host,
 * and they contradicted each other:
 *
 *   1. `crates/memphis-operator/src/config.rs` — the dimension default was
 *      `32`, hard-coded;
 *   2. `crates/memphis-napi/src/lib.rs` — the same `32`, hard-coded again,
 *      and the same mode vocabulary copied a second time;
 *   3. `src/infra/http/health.ts` — the dimension default was `32` again,
 *      and the index-path default was `~/.memphis/embed/index-v1.json`
 *      (HOME-based) while the Rust side used `<data_dir>/embed/index-v1.json`
 *      (data-dir-based) — two different files whenever `MEMPHIS_DATA_DIR`
 *      is not `~/.memphis`;
 *   4. `src/infra/tensors/status.ts` — `32` a fourth time, and the
 *      HOME-based path a third time.
 *
 * The `32` was never an embedding dimension: it is `DEFAULT_EMBEDDING_DIM`,
 * the width of the LOCAL DETERMINISTIC embedder, applied even when a real
 * provider was configured.
 *
 * MEASURED 2026-11-23 on the operator's host: the service answered
 * `mode: semantic` with dim 1024, while a shell, the CLI and any spawned
 * script answered dim 32 against an index that holds 768.
 *
 * TWO WAYS TO ASK
 * ---------------
 * `resolveEmbedProfile` THROWS when the bridge cannot answer — the house
 * style for a rule with one owner: a fallback would be a second copy of
 * the very rule this contract exists to end.
 *
 * `tryResolveEmbedProfile` reports the failure instead — for surfaces
 * whose job is to REPORT state (a health check must answer, even when
 * the answer is "the profile is unknown").
 */

import {
  bridgeEmbedProfileFacts,
  bridgeEmbedProfileManifest,
  type EmbedProfileFacts,
  type EmbedProfileManifest,
} from './rust-embed-profile-bridge.js';

export type { EmbedProfileFacts, EmbedProfileManifest };

/** The rule, as the owner publishes it. */
export function readEmbedProfileManifest(): EmbedProfileManifest {
  return bridgeEmbedProfileManifest();
}

/**
 * The profile of THIS environment, as the owner resolves it.
 *
 * Throws when the bridge cannot answer — the caller asked a question the
 * owner is the only one that may answer, and a guess would be a lie.
 */
export function resolveEmbedProfile(rawEnv: NodeJS.ProcessEnv = process.env): EmbedProfileFacts {
  return bridgeEmbedProfileFacts(rawEnv);
}

/** The profile, or the reason there is none. */
export interface EmbedProfileView {
  /** Whether the owner answered. */
  available: boolean;
  /** The owner's answer, when there is one. */
  facts: EmbedProfileFacts | null;
  /** Why there is no answer, when there is none. */
  reason: string | null;
}

/**
 * The profile, or the reason there is none.
 *
 * For surfaces that must answer whatever happens — a health check reports
 * "the embedding profile could not be resolved" instead of failing to
 * answer at all.
 */
export function tryResolveEmbedProfile(
  rawEnv: NodeJS.ProcessEnv = process.env,
): EmbedProfileView {
  try {
    return { available: true, facts: bridgeEmbedProfileFacts(rawEnv), reason: null };
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    return { available: false, facts: null, reason };
  }
}

/**
 * Whether the profile's dimension disagrees with the index on disk.
 *
 * A FACT of its own, separate from the verdict: the verdict names the
 * PRIMARY cause (a process without a provider is told that first), but
 * the dimension disagreement is a second, independent problem, and a
 * surface that only read the verdict would lose it.
 */
export function embedProfileDimensionMismatch(facts: EmbedProfileFacts): boolean {
  return facts.dimensionMismatch;
}
