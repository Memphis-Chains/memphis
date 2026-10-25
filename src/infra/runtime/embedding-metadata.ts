import { existsSync, statSync } from 'node:fs';
import { extname, join, resolve } from 'node:path';

import { resolveInstallRoot, resolveRustBridgePath } from './install-root.js';
import { getDataDir } from '../../config/paths.js';
import { loadPlatformAwareBridge, resolveBridgeContract } from '../storage/napi-contract.js';

export interface EmbeddingMetadata {
  schemaVersion: 1;
  path: string;
  formatVersion: number | null;
  state: 'missing' | 'unreadable' | 'empty' | 'corrupt' | 'degraded' | 'loaded' | 'unknown';
  documents: number | null;
  invalidRecords: number;
  dimension: number | null;
  sizeBytes: number;
}
const cache = new Map<string, { stamp: string; value: EmbeddingMetadata }>();

/** Canonical Rust metadata, cached by file identity. No provider or KDF calls. */
export function readEmbeddingMetadata(rawEnv: NodeJS.ProcessEnv = process.env): EmbeddingMetadata {
  const configured = rawEnv.RUST_EMBED_PERSIST_PATH?.trim();
  const path = configured
    ? resolve(resolveInstallRoot({ rawEnv }), configured)
    : join(getDataDir(rawEnv), 'embed', 'index-v1.json');
  const extension = extname(path);
  const sibling = `${extension ? path.slice(0, -extension.length) : path}.ndjson`;
  const selected = existsSync(sibling) ? sibling : path;
  const bridgePath = resolveRustBridgePath(rawEnv);
  let stamp = `${bridgePath}:missing`;
  try {
    const stat = statSync(selected, { bigint: true });
    stamp = `${bridgePath}:${selected}:${stat.ino}:${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}`;
  } catch { /* Rust returns the classified read failure. */ }
  const cached = cache.get(path);
  if (cached?.stamp === stamp) return { ...cached.value };
  const unknown: EmbeddingMetadata = { schemaVersion: 1, path: selected, formatVersion: null, state: 'unknown', documents: null, invalidRecords: 0, dimension: null, sizeBytes: 0 };
  try {
    const bridge = loadPlatformAwareBridge(bridgePath);
    const contract = resolveBridgeContract(bridge, { embed_index_metadata: ['embed_index_metadata', 'embedIndexMetadata'] });
    const inspect = contract.resolved.embed_index_metadata as ((path: string) => string) | undefined;
    if (!inspect) return unknown;
    const envelope = JSON.parse(inspect(path)) as { ok: boolean; data?: EmbeddingMetadata };
    if (!envelope.ok || envelope.data?.schemaVersion !== 1) return unknown;
    const value = envelope.data;
    if (cache.size >= 16) cache.clear();
    cache.set(path, { stamp, value });
    return { ...value };
  } catch { return unknown; }
}
