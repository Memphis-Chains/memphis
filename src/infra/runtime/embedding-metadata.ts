import { existsSync, statSync } from 'node:fs';
import { extname, resolve } from 'node:path';

import { resolveRustBridgePath } from './install-root.js';
import { tryResolveEmbedProfile } from '../storage/embed-profile.js';
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
  // The index path is the OWNER's answer. This used to rebuild it here —
  // `RUST_EMBED_PERSIST_PATH` resolved against the install root, else
  // `<data_dir>/embed/index-v1.json` — which is a SECOND copy of the path
  // rule: it did not expand `~`, and it resolved a relative path against
  // the install root instead of the runtime root. The rule lives in
  // `crates/memphis-embed/src/profile.rs`; this side asks.
  const view = tryResolveEmbedProfile(rawEnv);
  if (!view.available || !view.facts) {
    return {
      schemaVersion: 1,
      path: '',
      formatVersion: null,
      state: 'unknown',
      documents: null,
      invalidRecords: 0,
      dimension: null,
      sizeBytes: 0,
    };
  }

  const path = resolve(view.facts.indexPath);
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
