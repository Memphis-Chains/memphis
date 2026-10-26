import { requireToolContract } from './tool-contract.js';
import type { ToolMeta } from './tool-metadata.js';

/**
 * Policy for tools that exist on the native Rust surface.
 *
 * The contract in `tool-contract.ts` is the source of truth for the tier
 * and the capabilities of every natively executable tool. This module
 * projects that contract into the `ToolMeta` shape the rest of the
 * TypeScript side already speaks, so there is one place to change when a
 * tool's authorization level changes.
 *
 * Before this existed, `memphis_vault_list` carried a hand-written tier
 * here while the native Rust side carried a generated one, and
 * `TOOL_REGISTRY` did not contain the tool at all. Three sources, one
 * question, no comparison.
 */
export function nativeToolPolicy(name: string): ToolMeta {
  const contract = requireToolContract(name);
  return {
    name: contract.name,
    tier: contract.tier,
    capabilities: [...contract.capabilities],
    description: `Native operator tool: ${contract.name}.`,
  };
}

/**
 * Resolve the policy for a tool that may be executed natively.
 *
 * `registry` is consulted first so a tool that IS in the registry keeps
 * its full metadata — description, schema, help text, feature flag. The
 * contract is the fallback for native-only tools that the gateway does
 * not advertise.
 */
export function requireToolPolicy(name: string, registry: Record<string, ToolMeta>): ToolMeta {
  const metadata = registry[name] ?? nativeToolPolicy(name);
  if (
    !metadata ||
    !Number.isInteger(metadata.tier) ||
    metadata.tier < 0 ||
    metadata.tier > 3 ||
    !metadata.capabilities.length
  ) {
    throw new Error(`Missing or invalid native tool policy: ${name}`);
  }
  return metadata;
}
