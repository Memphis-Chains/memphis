import { createRequire } from 'node:module';

interface RustBridgeLike {
  embed_store?: (id: string, text: string) => string;
  embed_search?: (query: string, topK?: number) => string;
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
}

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

export function getRustEmbedAdapterStatus(rawEnv: NodeJS.ProcessEnv = process.env): RustEmbedAdapterStatus {
  const rustEnabled = parseBool(rawEnv.RUST_CHAIN_ENABLED, false);
  const rustBridgePath = getBridgePath(rawEnv);

  if (!rustEnabled) {
    return { rustEnabled, rustBridgePath, bridgeLoaded: false, embedApiAvailable: false };
  }

  const bridge = loadBridge(rustBridgePath);
  if (!bridge) {
    return { rustEnabled, rustBridgePath, bridgeLoaded: false, embedApiAvailable: false };
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
  const bridge = getBridgeOrThrow(rawEnv);
  return parseEnvelope(bridge.embed_search(query, topK));
}

export function embedReset(rawEnv: NodeJS.ProcessEnv = process.env): { cleared: boolean } {
  const bridge = getBridgeOrThrow(rawEnv);
  return parseEnvelope(bridge.embed_reset());
}
