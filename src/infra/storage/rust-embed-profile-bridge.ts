/**
 * The embed-profile bridge — the TypeScript side's ONLY way to ask which
 * embedding profile is in force.
 *
 * WHY THIS MODULE EXISTS
 * -----------------------
 * "Which embedding profile is in force?" had FOUR answers on this host, and
 * the answers contradicted each other:
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
 * The `32` was never an embedding dimension. It is `DEFAULT_EMBEDDING_DIM` —
 * the width of the LOCAL DETERMINISTIC embedder, the placeholder used when
 * no provider is configured. The configuration builder applied it
 * unconditionally, so a process with a real provider and no explicit
 * `RUST_EMBED_DIM` asked for 32-dim vectors from a model that produces 1024.
 *
 * MEASURED 2026-11-23 on the operator's host:
 *
 * | process | index it reads | dim | result |
 * | --- | --- | --- | --- |
 * | the service (systemd passes `.env`) | `embed/bge-m3-20261106/index-v1.json` | 1024 | `mode: semantic` |
 * | a shell, the CLI, a spawned script | `embed/index-v1.json` (stale) | 768 on disk vs **32** configured | `index_dimension_mismatch` |
 *
 * THE RULE LIVES IN RUST
 * ----------------------
 * The owner is `crates/memphis-embed/src/profile.rs`. This module does not
 * decide which index is read, how wide its vectors are or whether a
 * provider is available — it ASKS, through the bridge, and hands the
 * answer on. A second implementation of the rule on this side would be a
 * second copy of the very thing that had four copies already.
 *
 * FAILURE MODE
 * ------------
 * If the bridge cannot be loaded, the call throws. It does not fall back
 * to a TypeScript computation of the profile: that fallback is exactly
 * the silent split this contract exists to end (a fallback that answers
 * "32" while the service answers "1024" is a bug that only shows up on
 * the machine where it matters).
 */

import { callBridge as callBridgeEnvelope } from './bridge-envelope.js';
import { BRIDGE_EXPORT_ALIASES } from './bridge-exports.generated.js';
import {
  hasRequiredBridgeExports,
  loadPlatformAwareBridge,
  resolveBridgeContract,
  type BridgeAliasMap,
  type BridgeResolution,
} from './napi-contract.js';
import { bridgeBinaryPath, envToJson, pathResolutionBase } from './rust-bridge-host.js';

const EMBED_PROFILE_BRIDGE_ALIASES = {
  bridge_embed_profile_manifest: BRIDGE_EXPORT_ALIASES.bridge_embed_profile_manifest,
  bridge_embed_profile_facts: BRIDGE_EXPORT_ALIASES.bridge_embed_profile_facts,
} as const satisfies BridgeAliasMap<
  'bridge_embed_profile_manifest' | 'bridge_embed_profile_facts'
>;

type EmbedProfileBridgeKey = keyof typeof EMBED_PROFILE_BRIDGE_ALIASES;

/** The rule, as the owner publishes it. */
export interface EmbedProfileManifest {
  schemaVersion: number;
  env: {
    indexPath: string;
    dimension: string;
    model: string;
    mode: string;
  };
  defaults: {
    indexPath: string;
    dimension: string;
    model: string;
    localDimension: number;
  };
  dimensionSources: string[];
  verdicts: string[];
  modes: {
    local: string;
    providers: string[];
  };
}

/** The profile of one process, as the owner resolves it. */
export interface EmbedProfileFacts {
  schemaVersion: number;
  /** The index the runtime reads and writes. */
  indexPath: string;
  /** The dimension recorded in the index on disk, if the index is readable. */
  indexDimension: number | null;
  /** The dimension the operator configured explicitly. */
  configuredDimension: number | null;
  /** The dimension the embedder must produce. */
  dimension: number;
  /** `env`, `index` or `local-deterministic`. */
  dimensionSource: string;
  /** The embedding model, if one is configured. */
  model: string | null;
  /** `env` or `unknown`. */
  modelSource: string;
  /** Whether a provider is configured for this process. */
  providerConfigured: boolean;
  /** Whether the configured dimension disagrees with the index on disk. */
  dimensionMismatch: boolean;
  /** The mode in force: `local`, a provider name, or `cascade[...]`. */
  mode: string;
  /** `ok`, `no-provider`, `no-index` or `dimension-mismatch`. */
  verdict: string;
  /** What to do about the verdict, in one sentence. */
  remedy: string | null;
  /** What to do about the dimension disagreement, in one sentence. */
  dimensionRemedy: string | null;
}

const bridgeCache = new Map<string, BridgeResolution<EmbedProfileBridgeKey>>();

function getBridge(): BridgeResolution<EmbedProfileBridgeKey> {
  const inTreePath = bridgeBinaryPath();
  const cached = bridgeCache.get(inTreePath);
  if (cached !== undefined) return cached;
  const bridge = loadPlatformAwareBridge(inTreePath);
  const resolution = resolveBridgeContract(bridge, EMBED_PROFILE_BRIDGE_ALIASES);
  bridgeCache.set(inTreePath, resolution);
  return resolution;
}

function callBridge<T>(fnName: EmbedProfileBridgeKey, args: readonly unknown[]): T {
  const resolution = getBridge();
  if (!resolution.bridgeLoaded) {
    throw new Error(
      `embed-profile bridge unavailable — \`crates/memphis-embed\` NAPI module did not load. ` +
        'Rebuild via `npm run build:rust:release` or install the platform sub-package.',
    );
  }
  const fn = resolution.resolved[fnName];
  if (typeof fn !== 'function') {
    throw new Error(
      `embed-profile bridge missing export "${fnName}". ` +
        `Aliases tried: ${EMBED_PROFILE_BRIDGE_ALIASES[fnName].join(', ')}.`,
    );
  }
  return callBridgeEnvelope<T>(fnName, () => fn(...args) as string);
}

/** The rule, as the owner publishes it. */
export function bridgeEmbedProfileManifest(): EmbedProfileManifest {
  return callBridge<EmbedProfileManifest>('bridge_embed_profile_manifest', []);
}

/**
 * The profile of THIS environment, as the owner resolves it.
 *
 * The environment is an ARGUMENT, not the process environment: a surface
 * may be asked about a different environment (a test, a dry run, the setup
 * wizard), and the answer must be the owner's answer for that
 * environment — not a re-derivation on this side.
 */
export function bridgeEmbedProfileFacts(
  rawEnv: NodeJS.ProcessEnv = process.env,
): EmbedProfileFacts {
  return callBridge<EmbedProfileFacts>('bridge_embed_profile_facts', [
    envToJson(rawEnv),
    pathResolutionBase(rawEnv),
  ]);
}

/** Whether the bridge can answer the profile question at all. */
export function embedProfileBridgeAvailable(): boolean {
  return hasRequiredBridgeExports(getBridge(), [
    'bridge_embed_profile_manifest',
    'bridge_embed_profile_facts',
  ]);
}
