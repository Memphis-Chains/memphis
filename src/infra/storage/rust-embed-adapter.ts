import { createHash } from 'node:crypto';
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

type CacheEntry = {
  value: EmbedSearchResult;
  expiresAtMs: number;
};

const DEFAULT_EMBED_CACHE_SIZE = 1000;
const DEFAULT_EMBED_CACHE_TTL_SECONDS = 3600;
const embedSearchCache = new Map<string, CacheEntry>();

function parseBool(v: string | undefined, fallback = false): boolean {
  if (typeof v !== 'string') return fallback;
  return v.toLowerCase() === 'true';
}

function parsePositiveInt(v: string | undefined, fallback: number): number {
  if (typeof v !== 'string') return fallback;
  const parsed = Number.parseInt(v, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return parsed;
}

function getEmbedCacheSize(rawEnv: NodeJS.ProcessEnv): number {
  return parsePositiveInt(rawEnv.EMBED_CACHE_SIZE, DEFAULT_EMBED_CACHE_SIZE);
}

function getEmbedCacheTtlMs(rawEnv: NodeJS.ProcessEnv): number {
  const seconds = parsePositiveInt(rawEnv.EMBED_CACHE_TTL_SECONDS, DEFAULT_EMBED_CACHE_TTL_SECONDS);
  return seconds * 1000;
}

function buildCacheKey(query: string): string {
  return createHash('sha256').update(query).digest('hex');
}

function getCachedResult(query: string, _rawEnv: NodeJS.ProcessEnv): EmbedSearchResult | null {
  const key = buildCacheKey(query);
  const cached = embedSearchCache.get(key);
  if (!cached) return null;

  if (Date.now() > cached.expiresAtMs) {
    embedSearchCache.delete(key);
    return null;
  }

  // touch for LRU ordering
  embedSearchCache.delete(key);
  embedSearchCache.set(key, cached);
  return cached.value;
}

function setCachedResult(query: string, result: EmbedSearchResult, rawEnv: NodeJS.ProcessEnv): void {
  const key = buildCacheKey(query);
  const ttlMs = getEmbedCacheTtlMs(rawEnv);
  const maxSize = getEmbedCacheSize(rawEnv);

  embedSearchCache.delete(key);
  embedSearchCache.set(key, {
    value: result,
    expiresAtMs: Date.now() + ttlMs,
  });

  while (embedSearchCache.size > maxSize) {
    const oldestKey = embedSearchCache.keys().next().value;
    if (!oldestKey) break;
    embedSearchCache.delete(oldestKey);
  }
}

export function clearEmbedSearchCache(): { cleared: boolean; entries: number } {
  const entries = embedSearchCache.size;
  embedSearchCache.clear();
  return { cleared: true, entries };
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
): { query: string; count: number; hits: EmbedSearchHit[] } {
  const cached = getCachedResult(query, rawEnv);
  if (cached) {
    metrics.recordEmbedCacheHit();
    return cached;
  }

  metrics.recordEmbedCacheMiss();
  const bridge = getBridgeOrThrow(rawEnv);
  const result = parseEnvelope<EmbedSearchResult>(bridge.embed_search(query, topK));
  setCachedResult(query, result, rawEnv);
  return result;
}

export function embedSearchTuned(
  query: string,
  topK = 5,
  rawEnv: NodeJS.ProcessEnv = process.env,
): { query: string; count: number; hits: EmbedSearchHit[] } {
  const bridge = getBridgeOrThrow(rawEnv);
  if (typeof bridge.embed_search_tuned !== 'function') {
    return parseEnvelope(bridge.embed_search(query, topK));
  }
  return parseEnvelope(bridge.embed_search_tuned(query, topK));
}

export function embedReset(rawEnv: NodeJS.ProcessEnv = process.env): { cleared: boolean } {
  clearEmbedSearchCache();
  const bridge = getBridgeOrThrow(rawEnv);
  return parseEnvelope(bridge.embed_reset());
}
