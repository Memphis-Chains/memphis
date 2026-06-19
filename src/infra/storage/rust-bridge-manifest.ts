import {
  loadPlatformAwareBridge,
  resolveBridgeContract,
  type BridgeAliasMap,
} from './napi-contract.js';
import { parseBool } from '../../core/env.js';
import { resolveRustBridgePath } from '../runtime/install-root.js';

const BRIDGE_EXPORT_ALIASES = {
  bridge_manifest: ['bridge_manifest', 'bridgeManifest'],
  chain_append: ['chain_append', 'chainAppend'],
  chain_validate: ['chain_validate', 'chainValidate'],
  chain_query: ['chain_query', 'chainQuery'],
  vault_init_json: ['vault_init_json', 'vaultInitJson'],
  vault_init_full: ['vault_init_full', 'vaultInitFull'],
  vault_store: ['vault_store', 'vaultStore'],
  vault_retrieve: ['vault_retrieve', 'vaultRetrieve'],
  embed_store: ['embed_store', 'embedStore'],
  embed_store_many: ['embed_store_many', 'embedStoreMany'],
  embed_flush: ['embed_flush', 'embedFlush'],
  embed_search: ['embed_search', 'embedSearch'],
  embed_search_tuned: ['embed_search_tuned', 'embedSearchTuned'],
  embed_reset: ['embed_reset', 'embedReset'],
  embed_shutdown: ['embed_shutdown', 'embedShutdown'],
  soul_loop_step: ['soul_loop_step', 'soulLoopStep'],
  soul_replay: ['soul_replay', 'soulReplay'],
  case_append: ['case_append', 'caseAppend'],
  case_query: ['case_query', 'caseQuery'],
  case_rebuild: ['case_rebuild', 'caseRebuild'],
  paths_resolve_data_dir: ['paths_resolve_data_dir', 'pathsResolveDataDir'],
  paths_resolve_vault_state: ['paths_resolve_vault_state', 'pathsResolveVaultState'],
  paths_resolve_vault_entries: ['paths_resolve_vault_entries', 'pathsResolveVaultEntries'],
  paths_resolve_chains_dir: ['paths_resolve_chains_dir', 'pathsResolveChainsDir'],
  paths_resolve_chain_path: ['paths_resolve_chain_path', 'pathsResolveChainPath'],
  paths_resolve_embed_index: ['paths_resolve_embed_index', 'pathsResolveEmbedIndex'],
  paths_resolve_case_index: ['paths_resolve_case_index', 'pathsResolveCaseIndex'],
  paths_resolve_database_path: ['paths_resolve_database_path', 'pathsResolveDatabasePath'],
  paths_normalize_chain_name: ['paths_normalize_chain_name', 'pathsNormalizeChainName'],
  mv2_export: ['mv2_export', 'mv2Export'],
  mv2_inspect: ['mv2_inspect', 'mv2Inspect'],
} satisfies BridgeAliasMap<string>;

export type RustBridgeManifestExport = keyof typeof BRIDGE_EXPORT_ALIASES;

export const DEFAULT_REQUIRED_RUST_BRIDGE_EXPORTS = [
  'bridge_manifest',
  'chain_append',
  'chain_validate',
  'chain_query',
  'vault_init_json',
  'vault_init_full',
  'vault_store',
  'vault_retrieve',
  'embed_store',
  'embed_store_many',
  'embed_flush',
  'embed_search',
  'embed_search_tuned',
  'embed_reset',
  'embed_shutdown',
  'soul_loop_step',
  'soul_replay',
  'case_append',
  'case_query',
  'case_rebuild',
  'paths_resolve_data_dir',
  'paths_resolve_vault_state',
  'paths_resolve_vault_entries',
  'paths_resolve_chains_dir',
  'paths_resolve_chain_path',
  'paths_resolve_embed_index',
  'paths_resolve_case_index',
  'paths_resolve_database_path',
  'paths_normalize_chain_name',
] as const satisfies readonly RustBridgeManifestExport[];

export interface RustBridgeManifest {
  name: string;
  schemaVersion: number;
  exports: string[];
  requiredExports: string[];
  optionalExports?: string[];
}

export interface RustBridgeManifestStatus {
  rustEnabled: boolean;
  strictRequired: boolean;
  bridgePath: string;
  bridgeLoaded: boolean;
  manifestAvailable: boolean;
  manifest?: RustBridgeManifest;
  requiredExports: string[];
  missingRequiredExports: string[];
  legacyAliasesUsed: Record<string, string>;
  ok: boolean;
  level: 'ok' | 'warn' | 'fail';
  message: string;
}

interface Envelope<T> {
  ok: boolean;
  data?: T;
  error?: string;
}

export function strictRustBridgeRequired(rawEnv: NodeJS.ProcessEnv = process.env): boolean {
  return parseBool(rawEnv.MEMPHIS_STRICT_RUST_BRIDGE, false);
}

export function assessRustBridgeManifestStatus(
  rawEnv: NodeJS.ProcessEnv = process.env,
): RustBridgeManifestStatus {
  const rustEnabled = parseBool(rawEnv.RUST_CHAIN_ENABLED, false);
  const strictRequired = strictRustBridgeRequired(rawEnv);
  const bridgePath = resolveRustBridgePath(rawEnv);
  const requiredExports = [...DEFAULT_REQUIRED_RUST_BRIDGE_EXPORTS];

  if (!rustEnabled) {
    return {
      rustEnabled,
      strictRequired,
      bridgePath,
      bridgeLoaded: false,
      manifestAvailable: false,
      requiredExports,
      missingRequiredExports: requiredExports,
      legacyAliasesUsed: {},
      ok: !strictRequired,
      level: strictRequired ? 'fail' : 'warn',
      message: strictRequired
        ? 'Rust bridge disabled while MEMPHIS_STRICT_RUST_BRIDGE=1'
        : 'Rust bridge disabled; TS fallback may be used',
    };
  }

  const bridge = loadPlatformAwareBridge(bridgePath);
  const resolution = resolveBridgeContract(bridge, BRIDGE_EXPORT_ALIASES);
  if (!resolution.bridgeLoaded) {
    return {
      rustEnabled,
      strictRequired,
      bridgePath,
      bridgeLoaded: false,
      manifestAvailable: false,
      requiredExports,
      missingRequiredExports: requiredExports,
      legacyAliasesUsed: {},
      ok: false,
      level: 'fail',
      message: `Rust bridge not loadable at ${bridgePath}`,
    };
  }

  const manifestFn = resolution.resolved.bridge_manifest;
  const manifest = typeof manifestFn === 'function' ? readBridgeManifest(manifestFn) : undefined;
  const manifestRequired = manifest?.requiredExports?.length ? manifest.requiredExports : requiredExports;
  const effectiveRequired = uniqueStrings([
    ...requiredExports,
    ...manifestRequired.filter(isKnownBridgeExport),
  ]);
  const missingRequiredExports = effectiveRequired.filter(
    (key) => typeof resolution.resolved[key] !== 'function',
  );

  if (!manifest) {
    return {
      rustEnabled,
      strictRequired,
      bridgePath,
      bridgeLoaded: true,
      manifestAvailable: false,
      requiredExports: effectiveRequired,
      missingRequiredExports,
      legacyAliasesUsed: resolution.legacyAliasesUsed,
      ok: false,
      level: 'fail',
      message: 'Rust bridge loaded but bridge_manifest is missing or invalid',
    };
  }

  if (missingRequiredExports.length > 0) {
    return {
      rustEnabled,
      strictRequired,
      bridgePath,
      bridgeLoaded: true,
      manifestAvailable: true,
      manifest,
      requiredExports: effectiveRequired,
      missingRequiredExports,
      legacyAliasesUsed: resolution.legacyAliasesUsed,
      ok: false,
      level: 'fail',
      message: `Rust bridge missing required exports: ${missingRequiredExports.join(', ')}`,
    };
  }

  return {
    rustEnabled,
    strictRequired,
    bridgePath,
    bridgeLoaded: true,
    manifestAvailable: true,
    manifest,
    requiredExports: effectiveRequired,
    missingRequiredExports,
    legacyAliasesUsed: resolution.legacyAliasesUsed,
    ok: true,
    level: 'ok',
    message: `Rust bridge manifest OK (${effectiveRequired.length} required exports)`,
  };
}

function readBridgeManifest(manifestFn: (...args: unknown[]) => unknown): RustBridgeManifest | undefined {
  try {
    const raw = manifestFn();
    if (typeof raw !== 'string') return undefined;
    const envelope = JSON.parse(raw) as Envelope<RustBridgeManifest>;
    if (!envelope.ok || !envelope.data) return undefined;
    if (!Array.isArray(envelope.data.exports) || !Array.isArray(envelope.data.requiredExports)) {
      return undefined;
    }
    return envelope.data;
  } catch {
    return undefined;
  }
}

function uniqueStrings<T extends string>(values: readonly T[]): T[] {
  return [...new Set(values)];
}

function isKnownBridgeExport(value: string): value is RustBridgeManifestExport {
  return value in BRIDGE_EXPORT_ALIASES;
}
