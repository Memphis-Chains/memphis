import { createRequire } from 'node:module';
import { metrics } from '../logging/metrics.js';

interface RustBridgeLike {
  embed_store?: (id: string, text: string) => string;
  embed_search?: (query: string, topK?: number) => string;
  embed_search_tuned?: (query: string, topK?: number) => string;
  embed_reset?: () => string;
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

function parseBool(v: string | undefined, fallback = false): boolean {
  if (typeof v !== 'string') return fallback;
  return v.toLowerCase() === 'true';
}

function getBridgePath(rawEnv: NodeJS.ProcessEnv): string {
  return rawEnv.RUST_CHAIN_BRIDGE_PATH ?? './crates/memphis-napi';
}

function loadBridge(path: string): RustBridgeLike | null {
  try {
    const req = createRequire(`${process.cwd()}/`);
    return req(path) as RustBridgeLike;
  } catch {
    return null;
  }
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

export function getRustEmbedAdapterStatus(rawEnv: NodeJS.ProcessEnv = process.env): RustEmbedAdapterStatus {
  const rustEnabled = parseBool(rawEnv.RUST_CHAIN_ENABLED, false);
  const rustBridgePath = getBridgePath(rawEnv);

  if (!rustEnabled) {
    return { rustEnabled, rustBridgePath, bridgeLoaded: false, embedApiAvailable: false, tunedSearchAvailable: false };
  }

  const bridge = loadBridge(rustBridgePath);
  if (!bridge) {
    return { rustEnabled, rustBridgePath, bridgeLoaded: false, embedApiAvailable: false, tunedSearchAvailable: false };
  }

  const embedApiAvailable =
    typeof bridge.embed_store === 'function' &&
    typeof bridge.embed_search === 'function' &&
    typeof bridge.embed_reset === 'function';

  return {
    rustEnabled,
    rustBridgePath,
    bridgeLoaded: true,
    embedApiAvailable,
    tunedSearchAvailable: typeof bridge.embed_search_tuned === 'function',
  };
}

function getBridgeOrThrow(rawEnv: NodeJS.ProcessEnv = process.env): Required<RustBridgeLike> {
  const status = getRustEmbedAdapterStatus(rawEnv);
  if (!status.rustEnabled) throw new Error('RUST_CHAIN_ENABLED=false');
  if (!status.bridgeLoaded || !status.embedApiAvailable) throw new Error('rust embed bridge unavailable');

  const bridge = loadBridge(status.rustBridgePath);
  if (
    !bridge ||
    typeof bridge.embed_store !== 'function' ||
    typeof bridge.embed_search !== 'function' ||
    typeof bridge.embed_reset !== 'function'
  ) {
    throw new Error('rust embed bridge load failure');
  }

  return bridge as Required<RustBridgeLike>;
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
