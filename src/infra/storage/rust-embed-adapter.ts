import { callBridge } from './bridge-envelope.js';
import type {
  BridgePayloadOf,
  EmbedSearchHitPayload,
  EmbedSearchPayload,
  EmbedStoreManyPayload,
  EmbedStorePayload,
} from './bridge-payloads.generated.js';
import {
  hasRequiredBridgeExports,
  loadPlatformAwareBridge,
  resolveBridgeContract,
  type BridgeAliasMap,
} from './napi-contract.js';
import { parseBool } from '../../core/env.js';
import { errorTemplates } from '../../core/errors.js';
import { metrics } from '../logging/metrics.js';
import { resolveRustBridgePath } from '../runtime/install-root.js';
import { memoryEmbeddingMeta, type EmbeddingVectorMeta } from '../tensors/types.js';

const EMBED_BRIDGE_ALIASES = {
  embed_store: ['embed_store', 'embedStore'],
  embed_store_many: ['embed_store_many', 'embedStoreMany'],
  embed_search: ['embed_search', 'embedSearch'],
  embed_search_tuned: ['embed_search_tuned', 'embedSearchTuned'],
  embed_reset: ['embed_reset', 'embedReset'],
  embed_clear_in_memory: ['embed_clear_in_memory', 'embedClearInMemory'],
  embed_discard_replacement: ['embed_discard_replacement', 'embedDiscardReplacement'],
  embed_flush: ['embed_flush', 'embedFlush'],
} satisfies BridgeAliasMap<
  | 'embed_store'
  | 'embed_store_many'
  | 'embed_search'
  | 'embed_search_tuned'
  | 'embed_reset'
  | 'embed_clear_in_memory'
  | 'embed_discard_replacement'
  | 'embed_flush'
>;

interface NormalizedEmbedBridge {
  embed_store: (id: string, text: string, tagsJson?: string) => string;
  // Bulk + flush are optional so a TS runtime against an OLDER NAPI
  // binary still loads. Exported functions (`embedStoreMany`,
  // `embedFlush`) check the binding and fall back / throw clearly.
  embed_store_many?: (itemsJson: string) => string;
  embed_search: (query: string, topK?: number, tagsJson?: string) => string;
  embed_search_tuned?: (query: string, topK?: number, tagsJson?: string) => string;
  embed_reset: () => string;
  // ADR-006: in-memory-only clear. Optional so an OLDER NAPI binary that
  // predates the bulk-safe reindex path still loads. New build of the
  // NAPI crate exports it; legacy builds degrade to `embed_reset()` on
  // the caller side (embed-reindex.ts) if needed.
  embed_clear_in_memory?: () => string;
  embed_discard_replacement?: () => string;
  embed_flush?: () => string;
}

/**
 * The public shapes of the embed family.
 *
 * These used to be hand-written here, and one of them was WRONG: the
 * wire's `normalized` is a STRING — `'true'` or `'provider-dependent'` —
 * and the side declared `boolean | string`, then wrote a helper to guess
 * which of the two it had got. The helper also handled a `'false'` the
 * wire cannot send and a missing value the wire cannot send either.
 *
 * Now the wire's shape comes from the OWNER
 * (`bridge-payloads.generated.ts`, projected from
 * `crates/memphis-napi/src/bridge_payloads.rs`), and the vocabulary of
 * `normalized` is closed: `'true' | 'provider-dependent'`. The two fields
 * this side re-declares — `normalized` and `dtype` — are re-declared on
 * purpose: it TRANSLATES the wire's word into a boolean, and that
 * translation is its own business.
 */

/** One search hit, as the bridge carries it. */
export type EmbedSearchHit = EmbedSearchHitPayload;

/** The answer of `embed_store`, with the tensor this side builds. */
export interface EmbedStoreResult extends Omit<EmbedStorePayload, 'normalized' | 'dtype'> {
  dtype: 'f32';
  normalized: boolean | 'provider-dependent';
  tensor: EmbeddingVectorMeta;
}

/** The answer of `embed_store_many`. */
export interface EmbedStoreManyResult
  extends Omit<EmbedStoreManyPayload, 'normalized' | 'dtype'> {
  dtype: 'f32';
  normalized: boolean | 'provider-dependent';
}

/** The answer of `embed_search` and `embed_search_tuned`. */
export interface EmbedSearchResult extends Omit<EmbedSearchPayload, 'normalized' | 'dtype'> {
  dtype: 'f32';
  normalized: boolean | 'provider-dependent';
  tensor?: EmbeddingVectorMeta;
}

export interface RustEmbedAdapterStatus {
  rustEnabled: boolean;
  rustBridgePath: string;
  bridgeLoaded: boolean;
  embedApiAvailable: boolean;
  tunedSearchAvailable: boolean;
}

type CacheEntry = { value: EmbedSearchResult; expiresAt: number };

const EMBED_CACHE_MAX_ENTRIES = 128;
const embedSearchCache = new Map<string, CacheEntry>();

function getBridgePath(rawEnv: NodeJS.ProcessEnv): string {
  return resolveRustBridgePath(rawEnv);
}

/**
 * The wire's `normalized` word, translated into this side's own answer.
 *
 * The vocabulary is CLOSED and owned: `'true'` or `'provider-dependent'`.
 * The old helper also mapped a `'false'` — a word the wire cannot send —
 * and fell back to the provider name for a value that could not be
 * missing. Both were guesses about a contract the owner already knew, so
 * both are gone.
 */
function normalizeNormalized(
  value: EmbedStorePayload['normalized'],
): boolean | 'provider-dependent' {
  return value === 'true' ? true : 'provider-dependent';
}

function normalizeStoreResult(raw: EmbedStorePayload): EmbedStoreResult {
  const normalized = normalizeNormalized(raw.normalized);
  return {
    ...raw,
    dtype: 'f32',
    normalized,
    tensor: memoryEmbeddingMeta({
      dim: raw.dim,
      provider: raw.provider,
      // The wire's word, not a second copy of the rule that produced it.
      normalized,
      persistenceEnabled: raw.persistence_enabled,
      persistenceLoadState: raw.persistence_load_state,
    }),
  };
}

function normalizeStoreManyResult(raw: EmbedStoreManyPayload): EmbedStoreManyResult {
  return {
    ...raw,
    dtype: 'f32',
    normalized: normalizeNormalized(raw.normalized),
  };
}

function normalizeSearchResult(raw: EmbedSearchPayload): EmbedSearchResult {
  const normalized = normalizeNormalized(raw.normalized);
  return {
    ...raw,
    dtype: 'f32',
    normalized,
    tensor: memoryEmbeddingMeta({
      dim: raw.dim,
      provider: raw.provider,
      // The wire's word, not a second copy of the rule that produced it.
      normalized,
    }),
  };
}

function parseCacheTtlMs(rawEnv: NodeJS.ProcessEnv = process.env): number {
  const ttlSecondsRaw = rawEnv.EMBED_CACHE_TTL_SECONDS;
  if (!ttlSecondsRaw) return 15_000;
  const ttlSeconds = Number(ttlSecondsRaw);
  if (!Number.isFinite(ttlSeconds) || ttlSeconds <= 0) return 15_000;
  return Math.trunc(ttlSeconds * 1000);
}

function cacheKey(query: string, topK: number, tuned: boolean): string {
  return `${tuned ? 'tuned' : 'base'}::${topK}::${query}`;
}

function getFromCache(key: string, now: number): EmbedSearchResult | null {
  const entry = embedSearchCache.get(key);
  if (!entry) return null;
  if (entry.expiresAt <= now) {
    embedSearchCache.delete(key);
    return null;
  }

  // LRU touch.
  embedSearchCache.delete(key);
  embedSearchCache.set(key, entry);
  return entry.value;
}

function setToCache(key: string, value: EmbedSearchResult, ttlMs: number, now: number): void {
  embedSearchCache.set(key, { value, expiresAt: now + ttlMs });

  while (embedSearchCache.size > EMBED_CACHE_MAX_ENTRIES) {
    const oldestKey = embedSearchCache.keys().next().value as string | undefined;
    if (!oldestKey) break;
    embedSearchCache.delete(oldestKey);
  }
}

function resolveEmbedBridge(rawEnv: NodeJS.ProcessEnv = process.env) {
  const rustBridgePath = getBridgePath(rawEnv);
  const resolution = resolveBridgeContract(
    loadPlatformAwareBridge(rustBridgePath),
    EMBED_BRIDGE_ALIASES,
  );

  return {
    rustBridgePath,
    resolution,
  };
}

export function getRustEmbedAdapterStatus(
  rawEnv: NodeJS.ProcessEnv = process.env,
): RustEmbedAdapterStatus {
  const rustEnabled = parseBool(rawEnv.RUST_CHAIN_ENABLED);
  const rustBridgePath = getBridgePath(rawEnv);

  if (!rustEnabled) {
    return {
      rustEnabled,
      rustBridgePath,
      bridgeLoaded: false,
      embedApiAvailable: false,
      tunedSearchAvailable: false,
    };
  }

  const { resolution } = resolveEmbedBridge(rawEnv);
  if (!resolution.bridgeLoaded) {
    return {
      rustEnabled,
      rustBridgePath,
      bridgeLoaded: false,
      embedApiAvailable: false,
      tunedSearchAvailable: false,
    };
  }

  const embedApiAvailable = hasRequiredBridgeExports(resolution, [
    'embed_store',
    'embed_search',
    'embed_reset',
  ]);

  return {
    rustEnabled,
    rustBridgePath,
    bridgeLoaded: true,
    embedApiAvailable,
    tunedSearchAvailable: typeof resolution.resolved.embed_search_tuned === 'function',
  };
}

function getBridgeOrThrow(rawEnv: NodeJS.ProcessEnv = process.env): NormalizedEmbedBridge {
  const status = getRustEmbedAdapterStatus(rawEnv);
  if (!status.rustEnabled) {
    throw errorTemplates.bridgeUnavailable({
      component: 'Embed',
      bridgePath: status.rustBridgePath,
      message:
        'Embed requires Rust bridge. Set RUST_CHAIN_ENABLED=true and run: npm run build:rust',
    });
  }
  if (!status.bridgeLoaded || !status.embedApiAvailable) {
    throw errorTemplates.bridgeUnavailable({
      component: 'Embed',
      bridgePath: status.rustBridgePath,
      message: `Rust embed bridge not found at ${status.rustBridgePath}. Run: npm run build:rust`,
    });
  }

  const { resolution } = resolveEmbedBridge(rawEnv);
  if (!hasRequiredBridgeExports(resolution, ['embed_store', 'embed_search', 'embed_reset'])) {
    throw errorTemplates.bridgeLoadFailure({
      component: 'Embed',
      bridgePath: status.rustBridgePath,
    });
  }

  return {
    embed_store: resolution.resolved.embed_store as (
      id: string,
      text: string,
      tagsJson?: string,
    ) => string,
    embed_store_many: resolution.resolved.embed_store_many as
      | ((itemsJson: string) => string)
      | undefined,
    embed_search: resolution.resolved.embed_search as (
      query: string,
      topK?: number,
      tagsJson?: string,
    ) => string,
    embed_search_tuned: resolution.resolved.embed_search_tuned as
      | ((query: string, topK?: number, tagsJson?: string) => string)
      | undefined,
    embed_reset: resolution.resolved.embed_reset as () => string,
    embed_clear_in_memory: resolution.resolved.embed_clear_in_memory as (() => string) | undefined,
    embed_discard_replacement: resolution.resolved.embed_discard_replacement as
      | (() => string)
      | undefined,
    embed_flush: resolution.resolved.embed_flush as (() => string) | undefined,
  };
}

export function embedStore(
  id: string,
  text: string,
  rawEnv: NodeJS.ProcessEnv = process.env,
  tags?: string[],
): EmbedStoreResult {
  const bridge = getBridgeOrThrow(rawEnv);
  const tagsJson = tags && tags.length > 0 ? JSON.stringify(tags) : undefined;
  return normalizeStoreResult(
    callBridge<EmbedStorePayload>('embed_store', () => bridge.embed_store(id, text, tagsJson)),
  );
}

export function embedSearch(
  query: string,
  topK = 5,
  rawEnv: NodeJS.ProcessEnv = process.env,
  tags?: string[],
): EmbedSearchResult {
  const bridge = getBridgeOrThrow(rawEnv);
  const tagsJson = tags && tags.length > 0 ? JSON.stringify(tags) : undefined;
  const ttlMs = parseCacheTtlMs(rawEnv);
  const now = Date.now();
  const tagSuffix = tagsJson ? `::${tagsJson}` : '';
  const key = cacheKey(query, topK, false) + tagSuffix;
  const cached = getFromCache(key, now);

  if (cached) {
    metrics.recordEmbedCacheHit();
    metrics.recordEmbedQuery(cached.count);
    return cached;
  }

  metrics.recordEmbedCacheMiss();
  const out = normalizeSearchResult(
    callBridge<EmbedSearchPayload>('embed_search', () =>
      bridge.embed_search(query, topK, tagsJson),
    ),
  );
  setToCache(key, out, ttlMs, now);
  metrics.recordEmbedQuery(out.count);
  return out;
}

export function embedSearchTuned(
  query: string,
  topK = 5,
  rawEnv: NodeJS.ProcessEnv = process.env,
  tags?: string[],
): EmbedSearchResult {
  const bridge = getBridgeOrThrow(rawEnv);
  const tagsJson = tags && tags.length > 0 ? JSON.stringify(tags) : undefined;
  const ttlMs = parseCacheTtlMs(rawEnv);
  const now = Date.now();
  const tagSuffix = tagsJson ? `::${tagsJson}` : '';
  const key = cacheKey(query, topK, true) + tagSuffix;
  const cached = getFromCache(key, now);

  if (cached) {
    metrics.recordEmbedCacheHit();
    metrics.recordEmbedQuery(cached.count);
    return cached;
  }

  metrics.recordEmbedCacheMiss();
  const out =
    typeof bridge.embed_search_tuned !== 'function'
      ? normalizeSearchResult(
          callBridge<EmbedSearchPayload>('embed_search', () =>
            bridge.embed_search(query, topK, tagsJson),
          ),
        )
      : normalizeSearchResult(
          callBridge<EmbedSearchPayload>('embed_search_tuned', () =>
            (bridge.embed_search_tuned as (q: string, k: number, t?: string) => string)(
              query,
              topK,
              tagsJson,
            ),
          ),
        );
  setToCache(key, out, ttlMs, now);
  metrics.recordEmbedQuery(out.count);
  return out;
}

export function embedReset(
  rawEnv: NodeJS.ProcessEnv = process.env,
): BridgePayloadOf<'embed_reset'> {
  const bridge = getBridgeOrThrow(rawEnv);
  embedSearchCache.clear();
  return callBridge('embed_reset', () => bridge.embed_reset());
}

/**
 * In-memory only destructive clear (ADR-006, issue #628). The on-disk
 * index is left untouched until the caller invokes `embedFlush()`. Use
 * this from the bulk rebuilder instead of `embedReset()` — the legacy
 * `embedReset` commits a destructive empty write to disk before the new
 * payload is ready, which is the data-loss path documented in #628.
 *
 * Falls back to `embedReset()` if the loaded NAPI crate predates the
 * ADR-006 surface. The fallback is unsafe for the rebuilder but keeps
 * single-shot clears working on legacy builds.
 */
export function embedClearInMemory(
  rawEnv: NodeJS.ProcessEnv = process.env,
): BridgePayloadOf<'embed_clear_in_memory'> {
  const bridge = getBridgeOrThrow(rawEnv);
  embedSearchCache.clear();
  const clearInMemory = bridge.embed_clear_in_memory;
  if (typeof clearInMemory === 'function') {
    return callBridge('embed_clear_in_memory', () => clearInMemory());
  }
  // Legacy NAPI: best-effort degradation. Caller MUST be aware this is
  // not the safe path — the bulk rebuilder should detect the missing
  // binding at startup and refuse to proceed.
  return callBridge('embed_reset', () => bridge.embed_reset());
}

export interface EmbedStoreItem {
  id: string;
  text: string;
  tags?: string[];
}

export function isEmbedBulkAvailable(rawEnv: NodeJS.ProcessEnv = process.env): boolean {
  try {
    const bridge = getBridgeOrThrow(rawEnv);
    return (
      typeof bridge.embed_store_many === 'function' && typeof bridge.embed_flush === 'function'
    );
  } catch {
    return false;
  }
}

/** Rebuilds need a non-destructive clear and a way to abandon partial work. */
export function isEmbedRebuildSafe(rawEnv: NodeJS.ProcessEnv = process.env): boolean {
  try {
    const bridge = getBridgeOrThrow(rawEnv);
    return (
      typeof bridge.embed_store_many === 'function' &&
      typeof bridge.embed_flush === 'function' &&
      typeof bridge.embed_clear_in_memory === 'function' &&
      typeof bridge.embed_discard_replacement === 'function'
    );
  } catch {
    return false;
  }
}

/**
 * Drop a failed in-memory rebuild and reload the last persisted index.
 *
 * The payload has SEVEN keys in the initialized variant and THREE in the
 * not-initialized one. This side used to declare `{ discarded: boolean }`
 * and cast the other six away — it did not know they were there. Now it
 * returns the owner's payload, and the optional keys are optional because
 * the owner says so.
 */
export function embedDiscardReplacement(
  rawEnv: NodeJS.ProcessEnv = process.env,
): BridgePayloadOf<'embed_discard_replacement'> {
  const bridge = getBridgeOrThrow(rawEnv);
  const discardReplacement = bridge.embed_discard_replacement;
  if (typeof discardReplacement !== 'function') {
    throw new Error('rust embed bridge does not support discarding a partial rebuild');
  }
  embedSearchCache.clear();
  return callBridge('embed_discard_replacement', () => discardReplacement());
}

/**
 * Bulk upsert. Pass an array of `{id, text, tags?}`; the Rust pipeline
 * inserts every item under one Mutex acquisition and DEFERS the disk
 * write — caller MUST follow with `embedFlush()` to materialize.
 *
 * Throws if the loaded NAPI binary is older than the bulk surface
 * (operator hasn't rebuilt). Caller should check `isEmbedBulkAvailable`
 * to decide whether to use this path or fall back to a per-item loop
 * over `embedStore`.
 */
export function embedStoreMany(
  items: EmbedStoreItem[],
  rawEnv: NodeJS.ProcessEnv = process.env,
): EmbedStoreManyResult {
  const bridge = getBridgeOrThrow(rawEnv);
  if (typeof bridge.embed_store_many !== 'function') {
    throw new Error(
      'rust embed bridge does not export embed_store_many; rebuild the NAPI binary (memphis-rebuild-rust)',
    );
  }
  // Stale on-disk index might lag in-memory state once we start
  // deferring writes — invalidate the per-process search cache.
  embedSearchCache.clear();
  const storeMany = bridge.embed_store_many;
  if (typeof storeMany !== 'function') {
    throw new Error('rust embed bridge does not support bulk store');
  }
  // The wire's `normalized` is a word, not a boolean — the same
  // translation the single store does.
  return normalizeStoreManyResult(
    callBridge('embed_store_many', () => storeMany(JSON.stringify(items))),
  );
}

/**
 * Materialize the in-memory embedding index to disk. Surfaces I/O
 * errors (ENOSPC / EROFS / permission denied) so bulk rebuilders can
 * report them up — single-item `embedStore` keeps its best-effort
 * silent path for legacy callers.
 */
export function embedFlush(
  rawEnv: NodeJS.ProcessEnv = process.env,
): BridgePayloadOf<'embed_flush'> {
  const bridge = getBridgeOrThrow(rawEnv);
  if (typeof bridge.embed_flush !== 'function') {
    throw new Error(
      'rust embed bridge does not export embed_flush; rebuild the NAPI binary (memphis-rebuild-rust)',
    );
  }
  // Search cache may be stale relative to a freshly-flushed index
  // even though the in-memory pipeline is the authority.
  embedSearchCache.clear();
  const flush = bridge.embed_flush;
  if (typeof flush !== 'function') {
    throw new Error('rust embed bridge does not support flush');
  }
  return callBridge('embed_flush', () => flush());
}
