/**
 * Shared Bridge Utilities
 * 
 * Centralized utilities for loading and interacting with Rust NAPI bridges.
 * Eliminates duplication across chain-adapter, rust-chain-adapter, rust-vault-adapter, and rust-embed-adapter.
 * 
 * @module infra/storage/bridge-loader
 */

import { createRequire } from 'node:module';

import { z } from 'zod';

// ============================================================================
// Types
// ============================================================================

/** Generic bridge response envelope */
export interface BridgeEnvelope<T> {
  ok: boolean;
  data?: T;
  error?: string;
}

/** Base interface for all Rust bridges */
export interface RustBridgeLike {
  // Chain operations
  chain_append?: (chainJson: string, blockJson: string) => string;
  chain_validate?: (blockJson: string, prevJson?: string) => string;
  chain_query?: (chainJson: string, contains?: string, tag?: string) => string;
  // Vault operations
  vault_encrypt?: (key: string, plaintext: string) => string;
  vault_decrypt?: (entryJson: string) => string;
  vault_init?: (passphrase: string, recoveryQuestion: string, recoveryAnswer: string) => string;
  vault_add?: (key: string, plaintext: string) => string;
  vault_get?: (key: string) => string;
  vault_list?: () => string;
  // Embed operations
  embed_store?: (id: string, text: string) => string;
  embed_search?: (query: string, topK?: number) => string;
  embed_search_tuned?: (query: string, topK?: number) => string;
  embed_reset?: () => string;
  // CamelCase variants (NAPI)
  chainAppend?: (chainJson: string, blockJson: string) => string;
  chainValidate?: (blockJson: string, prevJson?: string) => string;
  chainQuery?: (chainJson: string, contains?: string, tag?: string) => string;
  vaultEncrypt?: (key: string, plaintext: string) => string;
  vaultDecrypt?: (entryJson: string) => string;
  embedStore?: (id: string, text: string) => string;
  embedSearch?: (query: string, topK?: number) => string;
  embedReset?: () => string;
}

// ============================================================================
// Zod Schemas (Runtime Validation)
// ============================================================================

const bridgeEnvelopeSchema = z.object({
  ok: z.boolean(),
  data: z.unknown().optional(),
  error: z.string().optional(),
});

// ============================================================================
// Utility Functions
// ============================================================================

/**
 * Parse boolean from string env var
 * @param value - String value or undefined
 * @param fallback - Default value if not set
 */
export function parseBool(value: string | undefined, fallback = false): boolean {
  if (typeof value !== 'string') return fallback;
  return value.toLowerCase() === 'true';
}

/**
 * Get default bridge path from environment
 */
export function getDefaultBridgePath(envVar: string, defaultPath: string, rawEnv: NodeJS.ProcessEnv): string {
  return rawEnv[envVar] ?? defaultPath;
}

/**
 * Load Rust bridge dynamically with caching
 */
const bridgeCache = new Map<string, RustBridgeLike | null>();

export function loadRustBridge(bridgePath: string): RustBridgeLike | null {
  // Return cached result if available
  if (bridgeCache.has(bridgePath)) {
    return bridgeCache.get(bridgePath) ?? null;
  }

  try {
    const req = createRequire(`${process.cwd()}/`);
    const bridge = req(bridgePath) as RustBridgeLike;
    bridgeCache.set(bridgePath, bridge);
    return bridge;
  } catch {
    bridgeCache.set(bridgePath, null);
    return null;
  }
}

/**
 * Clear bridge cache (useful for testing)
 */
export function clearBridgeCache(): void {
  bridgeCache.clear();
}

/**
 * Parse and validate bridge response with runtime type checking
 */
export function parseEnvelope<T>(raw: string, fnName: string, schema?: z.ZodSchema<T>): T {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(`${fnName}: invalid JSON response (${String(error)})`, { cause: error });
  }

  // Validate envelope structure
  const envelopeResult = bridgeEnvelopeSchema.safeParse(parsed);
  if (!envelopeResult.success) {
    throw new Error(`${fnName}: invalid bridge response envelope: ${envelopeResult.error.message}`);
  }

  const envelope = envelopeResult.data;

  if (!envelope.ok) {
    throw new Error(`${fnName}: ${envelope.error ?? 'bridge returned error'}`);
  }

  if (envelope.data === undefined) {
    throw new Error(`${fnName}: bridge returned empty data`);
  }

  // Optional: validate data against provided schema
  if (schema) {
    const dataResult = schema.safeParse(envelope.data);
    if (!dataResult.success) {
      throw new Error(`${fnName}: invalid response data: ${dataResult.error.message}`);
    }
    return dataResult.data;
  }

  return envelope.data as T;
}

/**
 * Simple parse without schema validation (legacy compatibility)
 */
export function parseEnvelopeSimple<T>(raw: string, fnName: string): T {
  let out: BridgeEnvelope<T>;
  try {
    out = JSON.parse(raw) as BridgeEnvelope<T>;
  } catch (error) {
    throw new Error(`${fnName}: invalid JSON response (${String(error)})`, { cause: error });
  }

  if (!out.ok) {
    throw new Error(`${fnName}: ${out.error ?? 'bridge returned error'}`);
  }

  if (out.data === undefined) {
    throw new Error(`${fnName}: bridge returned empty data`);
  }

  return out.data;
}

// ============================================================================
// Re-exports for backward compatibility
// ============================================================================

// Re-export commonly used types and functions for easy migration
export type { RustBridgeLike as BaseRustBridge };
