import { existsSync, statSync } from 'node:fs';
import { extname, resolve } from 'node:path';

import { resolveRustBridgePath } from './install-root.js';
import type { EmbedIndexMetadataPayload } from '../storage/bridge-payloads.generated.js';
import { tryResolveEmbedProfile } from '../storage/embed-profile.js';
import { loadPlatformAwareBridge, resolveBridgeContract } from '../storage/napi-contract.js';

/**
 * The embed index metadata — the OWNER's shape, untouched.
 *
 * This surface used to declare all eight fields by hand, and it declared
 * two of them wrong: the wire's `documents` is a number (Rust never sends
 * null) and the wire's `schemaVersion` is a number (always 1). The names
 * and the types now come from `bridge-payloads.generated.ts`, which is
 * projected from `crates/memphis-napi/src/bridge_payloads.rs` — so the
 * field names are the ones the built bridge really uses, and the closed
 * vocabulary of `state` is the one Rust really writes.
 *
 * What this side still owns is the QUESTION of whether it could ask at
 * all. When the bridge is not there, there is no metadata — and this
 * function says so by returning NOTHING. It used to invent a state
 * ('unknown') and a null document count instead: a shape the wire cannot
 * carry, written down by hand, next to the seven shapes it could.
 */
export type EmbeddingMetadata = EmbedIndexMetadataPayload;

const cache = new Map<string, { stamp: string; value: EmbeddingMetadata }>();

/** Canonical Rust metadata, cached by file identity. No provider or KDF calls. */
export function readEmbeddingMetadata(
  rawEnv: NodeJS.ProcessEnv = process.env,
): EmbeddingMetadata | undefined {
  // The index path is the OWNER's answer. This used to rebuild it here —
  // `RUST_EMBED_PERSIST_PATH` resolved against the install root, else
  // `<data_dir>/embed/index-v1.json` — which is a SECOND copy of the path
  // rule: it did not expand `~`, and it resolved a relative path against
  // the install root instead of the runtime root. The rule lives in
  // `crates/memphis-embed/src/profile.rs`; this side asks.
  const view = tryResolveEmbedProfile(rawEnv);
  if (!view.available || !view.facts) {
    return undefined;
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
  try {
    const bridge = loadPlatformAwareBridge(bridgePath);
    const contract = resolveBridgeContract(bridge, { embed_index_metadata: ['embed_index_metadata', 'embedIndexMetadata'] });
    const inspect = contract.resolved.embed_index_metadata as ((path: string) => string) | undefined;
    if (!inspect) return undefined;
    const envelope = JSON.parse(inspect(path)) as { ok: boolean; data?: EmbeddingMetadata };
    if (!envelope.ok || envelope.data?.schemaVersion !== 1) return undefined;
    const value = envelope.data;
    if (cache.size >= 16) cache.clear();
    cache.set(path, { stamp, value });
    return { ...value };
  } catch { return undefined; }
}
