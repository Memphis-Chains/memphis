/**
 * The bridge's export vocabulary — GENERATED, do not edit.
 *
 * Projected from the Rust core's table
 * (`crates/memphis-napi/src/bridge_exports.rs`) by
 * `scripts/sync-bridge-export-contract.mts`. Regenerate with:
 *
 * ```bash
 * npm run -s ops:sync-bridge-export-contract
 * ```
 *
 * Each entry is the CANONICAL name (the Rust function) and the spellings the
 * bridge may export it under: the name napi-rs exports today, and the
 * spelling it would use under the other convention. The first spelling is
 * the one the binary really has — the gate proves that against the built
 * module, not against a comment.
 */
import type { BridgeAliasMap } from './napi-contract.js';

export const BRIDGE_EXPORT_ALIASES = {
  bridge_chain_name_facts: ['bridge_chain_name_facts', 'bridgeChainNameFacts'],
  bridge_chain_name_manifest: ['bridge_chain_name_manifest', 'bridgeChainNameManifest'],
  bridge_embed_profile_facts: ['bridge_embed_profile_facts', 'bridgeEmbedProfileFacts'],
  bridge_embed_profile_manifest: ['bridge_embed_profile_manifest', 'bridgeEmbedProfileManifest'],
  bridge_payload_manifest: ['bridge_payload_manifest', 'bridgePayloadManifest'],
  bridge_manifest: ['bridge_manifest', 'bridgeManifest'],
  chain_append: ['chain_append', 'chainAppend'],
  chain_query: ['chain_query', 'chainQuery'],
  chain_validate: ['chain_validate', 'chainValidate'],
  case_append: ['case_append', 'caseAppend'],
  case_query: ['case_query', 'caseQuery'],
  case_rebuild: ['case_rebuild', 'caseRebuild'],
  case_index_status: ['case_index_status', 'caseIndexStatus'],
  embed_clear_in_memory: ['embed_clear_in_memory', 'embedClearInMemory'],
  embed_discard_replacement: ['embed_discard_replacement', 'embedDiscardReplacement'],
  embed_flush: ['embed_flush', 'embedFlush'],
  embed_index_metadata: ['embed_index_metadata', 'embedIndexMetadata'],
  embed_reset: ['embed_reset', 'embedReset'],
  embed_search: ['embed_search', 'embedSearch'],
  embed_search_tuned: ['embed_search_tuned', 'embedSearchTuned'],
  embed_shutdown: ['embed_shutdown', 'embedShutdown'],
  embed_store: ['embed_store', 'embedStore'],
  embed_store_many: ['embed_store_many', 'embedStoreMany'],
  mv2_export: ['mv2Export', 'mv2_export'],
  mv2_inspect: ['mv2Inspect', 'mv2_inspect'],
  paths_normalize_chain_name: ['pathsNormalizeChainName', 'paths_normalize_chain_name'],
  paths_resolve_case_index: ['pathsResolveCaseIndex', 'paths_resolve_case_index'],
  paths_resolve_chain_path: ['pathsResolveChainPath', 'paths_resolve_chain_path'],
  paths_resolve_chains_dir: ['pathsResolveChainsDir', 'paths_resolve_chains_dir'],
  paths_resolve_data_dir: ['pathsResolveDataDir', 'paths_resolve_data_dir'],
  paths_resolve_database_path: ['pathsResolveDatabasePath', 'paths_resolve_database_path'],
  paths_resolve_embed_index: ['pathsResolveEmbedIndex', 'paths_resolve_embed_index'],
  paths_resolve_vault_entries: ['pathsResolveVaultEntries', 'paths_resolve_vault_entries'],
  paths_resolve_vault_state: ['pathsResolveVaultState', 'paths_resolve_vault_state'],
  soul_loop_step: ['soul_loop_step', 'soulLoopStep'],
  soul_replay: ['soul_replay', 'soulReplay'],
  vault_decode_entry: ['vault_decode_entry', 'vaultDecodeEntry'],
  vault_init_full: ['vault_init_full', 'vaultInitFull'],
  vault_init_json: ['vault_init_json', 'vaultInitJson'],
  vault_load_state: ['vault_load_state', 'vaultLoadState'],
  vault_parse_entries: ['vault_parse_entries', 'vaultParseEntries'],
  vault_retrieve: ['vault_retrieve', 'vaultRetrieve'],
  vault_store: ['vault_store', 'vaultStore'],
} as const satisfies BridgeAliasMap<string>;

export type RustBridgeManifestExport = keyof typeof BRIDGE_EXPORT_ALIASES;

export const DEFAULT_REQUIRED_RUST_BRIDGE_EXPORTS = [
  'bridge_manifest',
  'chain_append',
  'chain_query',
  'chain_validate',
  'case_append',
  'case_query',
  'case_rebuild',
  'embed_flush',
  'embed_reset',
  'embed_search',
  'embed_search_tuned',
  'embed_shutdown',
  'embed_store',
  'embed_store_many',
  'paths_normalize_chain_name',
  'paths_resolve_case_index',
  'paths_resolve_chain_path',
  'paths_resolve_chains_dir',
  'paths_resolve_data_dir',
  'paths_resolve_database_path',
  'paths_resolve_embed_index',
  'paths_resolve_vault_entries',
  'paths_resolve_vault_state',
  'soul_loop_step',
  'soul_replay',
  'vault_decode_entry',
  'vault_init_full',
  'vault_init_json',
  'vault_load_state',
  'vault_parse_entries',
  'vault_retrieve',
  'vault_store',
] as const satisfies readonly RustBridgeManifestExport[];
