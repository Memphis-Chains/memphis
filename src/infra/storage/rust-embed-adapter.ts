import {
  hasRequiredBridgeExports,
  loadBridgeModule,
  resolveBridgeContract,
  type BridgeAliasMap,
} from './napi-contract.js';
import { parseBool } from '../../core/env.js';
import { errorTemplates } from '../../core/errors.js';
import { metrics } from '../logging/metrics.js';

const EMBED_BRIDGE_ALIASES = {
  embed_store: ['embed_store', 'embedStore'],
  embed_search: ['embed_search', 'embedSearch'],
  embed_search_tuned: ['embed_search_tuned', 'embedSearchTuned'],
  embed_reset: ['embed_reset', 'embedReset'],
} satisfies BridgeAliasMap<'embed_store' | 'embed_search' | 'embed_search_tuned' | 'embed_reset'>;

interface NormalizedEmbedBridge {
  embed_store: (id: string, text: string) => string;
  embed_search: (query: string, topK?: number) => string;
  embed_search_tuned?: (query: string, topK?: number) => string;
  embed_reset: () => string;
}

interface BridgeEnvelope<T> {
  ok: boolean;
  data?: T;
  error?: string;
}

export interface EmbedSearchHit {
  id: string;
  score: number;
  text_preview: string;
}

export interface RustEmbedAdapterStatus {
  rustEnabled: boolean;
  rustBridgePath: string;
  bridgeLoaded: boolean;
  embedApiAvailable: boolean;
  tunedSearchAvailable: boolean;
}

type EmbedSearchResult = { query: string; count: number; hits: EmbedSearchHit[] };

type CacheEntry = { value: EmbedSearchResult; expiresAt: number };

const EMBED_CACHE_MAX_ENTRIES = 128;
const embedSearchCache = new Map<string, CacheEntry>();

function getBridgePath(rawEnv: NodeJS.ProcessEnv): string {
  return rawEnv.RUST_CHAIN_BRIDGE_PATH ?? './crates/memphis-napi';
}

function parseEnvelope<T>(raw: string): T {
  const out = JSON.parse(raw) as BridgeEnvelope<T>;
  if (!out.ok) {
    throw new Error(out.error ?? 'rust bridge error');
  }
  if (out.data === undefined) {
    throw new Error('rust bridge returned empty data');
  }
  return out.data;
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
  const resolution = resolveBridgeContract(loadBridgeModule(rustBridgePath), EMBED_BRIDGE_ALIASES);

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
    embed_store: resolution.resolved.embed_store as (id: string, text: string) => string,
    embed_search: resolution.resolved.embed_search as (query: string, topK?: number) => string,
    embed_search_tuned: resolution.resolved.embed_search_tuned as
      | ((query: string, topK?: number) => string)
      | undefined,
    embed_reset: resolution.resolved.embed_reset as () => string,
  };
}

export function embedStore(
  id: string,
  text: string,
  rawEnv: NodeJS.ProcessEnv = process.env,
): { id: string; count: number; dim: number; provider: string } {
  const bridge = getBridgeOrThrow(rawEnv);
  return parseEnvelope(bridge.embed_store(id, text));
}

export function embedSearch(
  query: string,
  topK = 5,
  rawEnv: NodeJS.ProcessEnv = process.env,
): EmbedSearchResult {
  const bridge = getBridgeOrThrow(rawEnv);
  const ttlMs = parseCacheTtlMs(rawEnv);
  const now = Date.now();
  const key = cacheKey(query, topK, false);
  const cached = getFromCache(key, now);

  if (cached) {
    metrics.recordEmbedCacheHit();
    metrics.recordEmbedQuery(cached.count);
    return cached;
  }

  metrics.recordEmbedCacheMiss();
  const out = parseEnvelope<EmbedSearchResult>(bridge.embed_search(query, topK));
  setToCache(key, out, ttlMs, now);
  metrics.recordEmbedQuery(out.count);
  return out;
}

export function embedSearchTuned(
  query: string,
  topK = 5,
  rawEnv: NodeJS.ProcessEnv = process.env,
): EmbedSearchResult {
  const bridge = getBridgeOrThrow(rawEnv);
  const ttlMs = parseCacheTtlMs(rawEnv);
  const now = Date.now();
  const key = cacheKey(query, topK, true);
  const cached = getFromCache(key, now);

  if (cached) {
    metrics.recordEmbedCacheHit();
    metrics.recordEmbedQuery(cached.count);
    return cached;
  }

  metrics.recordEmbedCacheMiss();
  const out =
    typeof bridge.embed_search_tuned !== 'function'
      ? parseEnvelope<EmbedSearchResult>(bridge.embed_search(query, topK))
      : parseEnvelope<EmbedSearchResult>(bridge.embed_search_tuned(query, topK));
  setToCache(key, out, ttlMs, now);
  metrics.recordEmbedQuery(out.count);
  return out;
}

export function embedReset(rawEnv: NodeJS.ProcessEnv = process.env): { cleared: boolean } {
  const bridge = getBridgeOrThrow(rawEnv);
  embedSearchCache.clear();
  return parseEnvelope(bridge.embed_reset());
}
