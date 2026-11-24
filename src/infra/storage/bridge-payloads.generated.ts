/**
 * The bridge's payload shapes — GENERATED, do not edit.
 *
 * Projected from the Rust core's table
 * (`crates/memphis-napi/src/bridge_payloads.rs`) by
 * `scripts/sync-bridge-payload-contract.mts`. Regenerate with:
 *
 * ```bash
 * npm run -s ops:sync-bridge-payload-contract
 * ```
 *
 * The spelling of every field here is the spelling the BUILT bridge puts
 * on the wire, read off the module itself — not a guess. Where the Rust
 * owner speaks two conventions (a `#[napi(object)]` struct with an
 * explicit `js_name` speaks snake_case, one without it speaks
 * camelCase), each export keeps its own shape and the mirror says so.
 *
 * An ENUM field carries the CLOSED set of words the wire can send — the
 * owner declares them, and the Rust gate checks them against the source
 * that writes them. So `normalized` here is
 * `'true' | 'provider-dependent'`, not `string`: a wire word that
 * nobody declared is a type error, not a silent string.
 */
/** napiObject — an explicit `js_name` verbatim, a field without one in camelCase. */
export interface VaultPayload {
  salt: Buffer;
  master_key?: Buffer;
  /** The spelling before the 2026-03-21 naming stabilization. Declared by the owner. */
  masterKey?: Buffer;
}

/** napiObject — an explicit `js_name` verbatim, a field without one in camelCase. */
export interface VaultEntryPayload {
  id: string;
  key: string;
  ciphertext: Buffer;
  nonce: Buffer;
  tag: Buffer;
  created_at?: string;
  /** The spelling before the 2026-03-21 naming stabilization. Declared by the owner. */
  createdAt?: string;
}

/** napiObject — an explicit `js_name` verbatim, a field without one in camelCase. */
export interface VaultInitPayload {
  vault: VaultPayload;
  did: string;
  qa_question: string;
}

/** napiObject — an explicit `js_name` verbatim, a field without one in camelCase. */
export interface VaultLoadStatePayload {
  vault?: VaultPayload;
  version?: number;
  error_code?: string;
  error?: string;
}

/** napiObject — an explicit `js_name` verbatim, a field without one in camelCase. */
export interface VaultEntriesPayload {
  entriesJson?: string;
  entry?: VaultEntryPayload;
  errorCode?: string;
}

/** serde — serde's rule — `rename_all = "camelCase"` camelCases, a field without it keeps its own name. */
export interface EmbedStorePayload {
  id: string;
  count: number;
  dim: number;
  dtype: 'f32';
  provider: string;
  normalized: 'true' | 'provider-dependent';
  persistence_enabled: boolean;
  persistence_load_state: 'disabled' | 'missing' | 'empty' | 'loaded' | 'corrupt';
}

/** serde — serde's rule — `rename_all = "camelCase"` camelCases, a field without it keeps its own name. */
export interface EmbedStoreManyPayload {
  inserted: number;
  count: number;
  dim: number;
  dtype: 'f32';
  provider: string;
  normalized: 'true' | 'provider-dependent';
  persistence_enabled: boolean;
}

/** serde — serde's rule — `rename_all = "camelCase"` camelCases, a field without it keeps its own name. */
export interface EmbedFlushPayload {
  flushed: boolean;
  dim: number;
  dtype: 'f32';
}

/** serde — serde's rule — `rename_all = "camelCase"` camelCases, a field without it keeps its own name. */
export interface EmbedSearchHitPayload {
  id: string;
  score: number;
  text_preview: string;
  tags: string[];
}

/** serde — serde's rule — `rename_all = "camelCase"` camelCases, a field without it keeps its own name. */
export interface EmbedSearchPayload {
  query: string;
  count: number;
  dim: number;
  dtype: 'f32';
  provider: string;
  normalized: 'true' | 'provider-dependent';
  hits: EmbedSearchHitPayload[];
}

/** serde — serde's rule — `rename_all = "camelCase"` camelCases, a field without it keeps its own name. */
export interface EmbedClearPayload {
  cleared: boolean;
}

/** serde — serde's rule — `rename_all = "camelCase"` camelCases, a field without it keeps its own name. */
export interface EmbedResetPayload {
  cleared: boolean;
}

/** serde — serde's rule — `rename_all = "camelCase"` camelCases, a field without it keeps its own name. */
export interface EmbedDiscardPayload {
  discarded: boolean;
  was_initialized: boolean;
  previous_replacement_state?: 'idle' | 'armed' | 'failed';
  replacement_state: 'idle' | 'armed' | 'failed';
  count?: number;
  persistence_enabled?: boolean;
  persistence_load_state?: 'disabled' | 'missing' | 'empty' | 'loaded' | 'corrupt';
}

/** serde — serde's rule — `rename_all = "camelCase"` camelCases, a field without it keeps its own name. */
export interface EmbedIndexMetadataPayload {
  schemaVersion: number;
  path: string;
  formatVersion: number | null;
  state: 'missing' | 'unreadable' | 'empty' | 'corrupt' | 'degraded' | 'loaded';
  documents: number;
  invalidRecords: number;
  dimension: number | null;
  sizeBytes: number;
}

/** The payload each bridge export carries. */
export interface BridgePayloadMap {
  vault_init_full: VaultInitPayload;
  vault_load_state: VaultLoadStatePayload;
  vault_parse_entries: VaultEntriesPayload;
  vault_decode_entry: VaultEntriesPayload;
  vault_store: VaultEntryPayload;
  vault_retrieve: Buffer;
  embed_store: EmbedStorePayload;
  embed_store_many: EmbedStoreManyPayload;
  embed_flush: EmbedFlushPayload;
  embed_search: EmbedSearchPayload;
  embed_search_tuned: EmbedSearchPayload;
  embed_clear_in_memory: EmbedClearPayload;
  embed_reset: EmbedResetPayload;
  embed_discard_replacement: EmbedDiscardPayload;
  embed_index_metadata: EmbedIndexMetadataPayload;
}

export type BridgePayloadExport = keyof BridgePayloadMap;

export type BridgePayloadOf<K extends BridgePayloadExport> = BridgePayloadMap[K];
