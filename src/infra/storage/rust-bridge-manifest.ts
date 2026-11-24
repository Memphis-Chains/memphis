import {
  BRIDGE_EXPORT_ALIASES,
  DEFAULT_REQUIRED_RUST_BRIDGE_EXPORTS,
  type RustBridgeManifestExport,
} from './bridge-exports.generated.js';
import type { BridgeManifestPayload } from './bridge-payloads.generated.js';
import {
  loadPlatformAwareBridge,
  resolveBridgeContract,
} from './napi-contract.js';
import { parseBool } from '../../core/env.js';
import { resolveRustBridgePath } from '../runtime/install-root.js';

/**
 * The bridge's export vocabulary is NOT written here.
 *
 * It is projected from the Rust core's table
 * (`crates/memphis-napi/src/bridge_exports.rs`) into
 * `src/infra/storage/bridge-exports.generated.ts` by
 * `scripts/sync-bridge-export-contract.mts`, and the projection is checked
 * against the built binary — so the map below cannot drift away from what
 * the bridge really exports.
 *
 * Measured 2026-11-23 on this host: the hand-written map that used to live
 * here named 34 exports where the bridge has 37, could not name three of
 * them at all, and carried 68 spellings of which **34 never matched** any
 * export.
 */
export { BRIDGE_EXPORT_ALIASES, DEFAULT_REQUIRED_RUST_BRIDGE_EXPORTS };
export type { RustBridgeManifestExport };

/**
 * The manifest the bridge serves — the OWNER's shape.
 *
 * This used to be a hand-written interface with two fields the wire
 * always sends marked OPTIONAL (`exportBindings` and `optionalExports`),
 * and `optionalExports` — the one field the wire carried WRONG — was
 * read by nobody at all. The shape now comes from
 * `bridge-payloads.generated.ts` — projected from
 * `crates/memphis-napi/src/bridge_payloads.rs`.
 *
 * `exportBindings` is optional in the owner's shape too, and for a
 * measured reason: a binary older than the vocabulary table (before
 * 2026-11-23) does not send it, and the export projection fails loudly
 * when it is missing.
 */
export type RustBridgeManifest = BridgeManifestPayload;

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
  const manifestRequired = manifest?.requiredExports?.length
    ? manifest.requiredExports
    : requiredExports;
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

function readBridgeManifest(
  manifestFn: (...args: unknown[]) => unknown,
): RustBridgeManifest | undefined {
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
