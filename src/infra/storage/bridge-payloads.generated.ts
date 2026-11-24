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
 */
export interface VaultPayload {
  salt: Buffer;
  master_key?: Buffer;
  /** The spelling before the 2026-03-21 naming stabilization. Declared by the owner. */
  masterKey?: Buffer;
}

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

export interface VaultInitPayload {
  vault: VaultPayload;
  did: string;
  qa_question: string;
}

export interface VaultLoadStatePayload {
  vault?: VaultPayload;
  version?: number;
  error_code?: string;
  error?: string;
}

export interface VaultEntriesPayload {
  entriesJson?: string;
  entry?: VaultEntryPayload;
  errorCode?: string;
}

/** The payload each bridge export carries. */
export interface BridgePayloadMap {
  vault_init_full: VaultInitPayload;
  vault_load_state: VaultLoadStatePayload;
  vault_parse_entries: VaultEntriesPayload;
  vault_decode_entry: VaultEntriesPayload;
  vault_store: VaultEntryPayload;
  vault_retrieve: Buffer;
}

export type BridgePayloadExport = keyof BridgePayloadMap;

export type BridgePayloadOf<K extends BridgePayloadExport> = BridgePayloadMap[K];
