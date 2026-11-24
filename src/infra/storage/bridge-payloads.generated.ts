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
/** serde — serde's rule — `rename_all = "camelCase"` camelCases, a field without it keeps its own name. */
export interface BridgeManifestPayload {
  exportBindings?: BridgeExportBindingPayload[];
  exports: string[];
  name: string;
  optionalExports: string[];
  requiredExports: string[];
  schemaVersion: number;
}

/** serde — serde's rule — `rename_all = "camelCase"` camelCases, a field without it keeps its own name. */
export interface BridgeExportBindingPayload {
  canonical: string;
  jsName: string;
  required: boolean;
}

/** serde — serde's rule — `rename_all = "camelCase"` camelCases, a field without it keeps its own name. */
export interface CaseIndexStatusPayload {
  indexed: number;
  lastIndexedBlock: number | null;
}

/** serde — serde's rule — `rename_all = "camelCase"` camelCases, a field without it keeps its own name. */
export interface EmbedProfileManifestPayload {
  schemaVersion: number;
  env: EmbedProfileEnvPayload;
  defaults: EmbedProfileDefaultsPayload;
  dimensionSources: ('env' | 'index' | 'local-deterministic')[];
  verdicts: ('ok' | 'no-provider' | 'no-index' | 'dimension-mismatch')[];
  modes: EmbedProfileModesPayload;
}

/** serde — serde's rule — `rename_all = "camelCase"` camelCases, a field without it keeps its own name. */
export interface EmbedProfileEnvPayload {
  indexPath: string;
  dimension: string;
  model: string;
  mode: string;
}

/** serde — serde's rule — `rename_all = "camelCase"` camelCases, a field without it keeps its own name. */
export interface EmbedProfileDefaultsPayload {
  indexPath: string;
  dimension: string;
  model: string;
  localDimension: number;
}

/** serde — serde's rule — `rename_all = "camelCase"` camelCases, a field without it keeps its own name. */
export interface EmbedProfileModesPayload {
  local: string;
  alias: string;
  providers: ('openai-compatible' | 'ollama' | 'cohere' | 'voyage' | 'jina' | 'mistral' | 'together' | 'nvidia' | 'mixedbread')[];
}

/** serde — serde's rule — `rename_all = "camelCase"` camelCases, a field without it keeps its own name. */
export interface EmbedProfileFactsPayload {
  schemaVersion: number;
  indexPath: string;
  indexDimension: number | null;
  configuredDimension: number | null;
  dimension: number;
  dimensionSource: 'env' | 'index' | 'local-deterministic';
  model: string | null;
  modelSource: 'env' | 'unknown';
  providerConfigured: boolean;
  dimensionMismatch: boolean;
  mode: string;
  verdict: 'ok' | 'no-provider' | 'no-index' | 'dimension-mismatch';
  remedy: string | null;
  dimensionRemedy: string | null;
}

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

/** serde — serde's rule — `rename_all = "camelCase"` camelCases, a field without it keeps its own name. */
export interface ChainValidatePayload {
  valid: boolean;
  errors?: string[];
}

/** serde — serde's rule — `rename_all = "camelCase"` camelCases, a field without it keeps its own name. */
export interface ChainAppendPayload {
  appended: boolean;
  errors?: string[];
  length?: number;
  chain?: BlockPayload[];
}

/** serde — serde's rule — `rename_all = "camelCase"` camelCases, a field without it keeps its own name. */
export interface ChainQueryPayload {
  count: number;
  blocks: BlockPayload[];
}

/** serde — serde's rule — `rename_all = "camelCase"` camelCases, a field without it keeps its own name. */
export interface BlockPayload {
  index: number;
  timestamp: string;
  chain: string;
  data: BlockDataPayload;
  prev_hash: string;
  hash: string;
  signer?: string;
  signature?: string;
}

/** serde — serde's rule — `rename_all = "camelCase"` camelCases, a field without it keeps its own name. */
export interface BlockDataPayload {
  type: 'journal' | 'ask' | 'decision' | 'system' | 'system_event' | 'insight' | 'tool_call' | 'tool_result' | 'error' | 'case' | 'wallet_tx_requested' | 'wallet_tx_signed' | 'wallet_tx_broadcast' | 'wallet_tx_confirmed' | 'wallet_tx_failed';
  content: string;
  tags: string[];
}

/** serde — serde's rule — `rename_all = "camelCase"` camelCases, a field without it keeps its own name. */
export interface SoulLoopStepPayload {
  applied: boolean;
  reason?: string;
  state: LoopStatePayload;
}

/** serde — serde's rule — `rename_all = "camelCase"` camelCases, a field without it keeps its own name. */
export interface LoopStatePayload {
  steps: number;
  tool_calls: number;
  wait_ms: number;
  errors: number;
  completed: boolean;
  halt_reason: string | null;
}

/** serde — serde's rule — `rename_all = "camelCase"` camelCases, a field without it keeps its own name. */
export interface SoulReplayPayload {
  accepted: number;
  rejected: number;
  errors: string[];
  snapshot: ReplaySnapshotPayload;
}

/** serde — serde's rule — `rename_all = "camelCase"` camelCases, a field without it keeps its own name. */
export interface ReplaySnapshotPayload {
  blocks: number;
  last_hash: string | null;
  state_hash: string;
}

/** serde — serde's rule — `rename_all = "camelCase"` camelCases, a field without it keeps its own name. */
export interface CaseAppendPayload {
  appended: boolean;
  errors?: string[];
  indexed?: boolean;
  length?: number;
  chain?: BlockPayload[];
}

/** serde — serde's rule — `rename_all = "camelCase"` camelCases, a field without it keeps its own name. */
export interface CaseQueryPayload {
  count: number;
  entries: CaseIndexRowPayload[];
}

/** serde — serde's rule — `rename_all = "camelCase"` camelCases, a field without it keeps its own name. */
export interface CaseIndexRowPayload {
  block_index: number;
  block_hash: string;
  chain: string;
  case_type: string;
  full_json: string;
  entry: CaseEntryPayload;
}

/** serde — serde's rule — `rename_all = "camelCase"` camelCases, a field without it keeps its own name. */
export interface CaseEntryPayload {
  case_type: 'nominative' | 'genitive' | 'dative' | 'accusative' | 'instrumental' | 'locative' | 'ablative' | 'vocative';
  entity?: string;
  action?: string;
  timestamp?: string;
  owner?: string;
  possessed?: string;
  giver?: string;
  recipient?: string;
  object?: string;
  subject?: string;
  verb?: string;
  actor?: string;
  instrument?: string;
  target?: string;
  location?: string;
  origin?: string;
  destination?: string;
  invoker?: string;
  invocation?: string;
}

/** serde — serde's rule — `rename_all = "camelCase"` camelCases, a field without it keeps its own name. */
export interface CaseRebuildPayload {
  indexed: number;
  skipped: number;
  errors: number;
}

/** The payload each bridge export carries. */
export interface BridgePayloadMap {
  bridge_manifest: BridgeManifestPayload;
  bridge_embed_profile_manifest: EmbedProfileManifestPayload;
  bridge_embed_profile_facts: EmbedProfileFactsPayload;
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
  chain_validate: ChainValidatePayload;
  chain_append: ChainAppendPayload;
  chain_query: ChainQueryPayload;
  soul_loop_step: SoulLoopStepPayload;
  soul_replay: SoulReplayPayload;
  case_append: CaseAppendPayload;
  case_query: CaseQueryPayload;
  case_rebuild: CaseRebuildPayload;
  case_index_status: CaseIndexStatusPayload;
}

export type BridgePayloadExport = keyof BridgePayloadMap;

export type BridgePayloadOf<K extends BridgePayloadExport> = BridgePayloadMap[K];
