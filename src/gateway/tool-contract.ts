/**
 * The tool contract shared by every surface.
 *
 * WHY THIS FILE EXISTS
 * --------------------
 * The TypeScript gateway and the native Rust operator both execute tools
 * and both decide how much authorization a tool needs. They read that
 * decision from two different places:
 *
 *   - TypeScript: `TOOL_REGISTRY` in `tool-registry.ts`
 *   - Rust:       the generated `tool_tier` table in
 *                 `crates/memphis-operator/src/chat_tool_catalog.rs`
 *
 * The tier table is generated from the registry by
 * `scripts/sync-native-tiers.mts`, and `--check` fails the build on
 * drift — so the TIERS cannot silently diverge. But the tiers were only
 * one part of the contract. The rest of it — which capabilities a tool
 * has, whether it is exposed natively, what the model is told about it —
 * was duplicated by hand and nothing compared the two sides.
 *
 * A tool that exists on one surface and not the other is the visible
 * symptom: `memphis_vault_list` was executable natively, absent from
 * `TOOL_REGISTRY`, and therefore invisible to every check that reads the
 * registry. The native surface ran it under a hand-written policy in
 * `native-tool-policy.ts`, and the registry had no idea it existed.
 *
 * This file is the single place that says which tools exist, what tier
 * they need, and where they are exposed. Both the Rust generator and the
 * TypeScript registry read it. A tool that is executable on either
 * surface MUST appear here, and a test proves it.
 */

/**
 * Where a tool can be executed.
 *
 * `native` — the Rust operator cockpit (authoritative operator surface).
 * `gateway` — the TypeScript host transport: HTTP, MCP, Telegram.
 */
export type ToolExposure = 'native' | 'gateway';

export interface ToolContract {
  readonly name: string;
  /** Minimum authorization tier. Mirrors `ToolMeta.tier`. */
  readonly tier: 0 | 1 | 2 | 3;
  /** What the tool can do. Mirrors `ToolMeta.capabilities`. */
  readonly capabilities: readonly ('read' | 'write' | 'network' | 'execute')[];
  /** Surfaces that can execute this tool. */
  readonly exposures: readonly ToolExposure[];
  /**
   * Tools that are deliberately not advertised on the gateway. They stay
   * in the registry so the tier, the capabilities and the schema have one
   * home, but the gateway must not list them.
   */
  readonly gatewayHidden?: boolean;
}

/**
 * The tools the native Rust operator can execute.
 *
 * This list is the one the Rust side advertises to the model. It is
 * checked against the Rust catalog and dispatcher by
 * `scripts/sync-native-tiers.mts`, and against the TypeScript registry by
 * `tests/unit/tool-contract.test.ts`.
 */
export const NATIVE_TOOL_CONTRACTS: readonly ToolContract[] = [
  {
    name: 'memphis_case_append',
    tier: 0,
    capabilities: ['write'],
    exposures: ['native', 'gateway'],
  },
  {
    name: 'memphis_case_query',
    tier: 0,
    capabilities: ['read'],
    exposures: ['native', 'gateway'],
  },
  {
    name: 'memphis_chain_query',
    tier: 0,
    capabilities: ['read'],
    exposures: ['native', 'gateway'],
  },
  {
    name: 'memphis_chain_verify',
    tier: 0,
    capabilities: ['read'],
    exposures: ['native', 'gateway'],
  },
  {
    name: 'memphis_classify',
    tier: 2,
    capabilities: ['read', 'network'],
    exposures: ['native', 'gateway'],
  },
  {
    name: 'memphis_code_read',
    tier: 2,
    capabilities: ['read'],
    exposures: ['native', 'gateway'],
  },
  {
    name: 'memphis_cron',
    tier: 2,
    capabilities: ['execute', 'write'],
    exposures: ['native', 'gateway'],
  },
  {
    name: 'memphis_decide',
    tier: 0,
    capabilities: ['write'],
    exposures: ['native', 'gateway'],
  },
  {
    name: 'memphis_exec',
    tier: 2,
    capabilities: ['execute'],
    exposures: ['native', 'gateway'],
  },
  {
    name: 'memphis_git',
    tier: 2,
    capabilities: ['read', 'write'],
    exposures: ['native', 'gateway'],
  },
  {
    name: 'memphis_glob',
    tier: 2,
    capabilities: ['read'],
    exposures: ['native', 'gateway'],
  },
  {
    name: 'memphis_grep',
    tier: 2,
    capabilities: ['read'],
    exposures: ['native', 'gateway'],
  },
  {
    name: 'memphis_health',
    tier: 0,
    capabilities: ['read'],
    exposures: ['native', 'gateway'],
  },
  {
    name: 'memphis_journal',
    tier: 0,
    capabilities: ['write'],
    exposures: ['native', 'gateway'],
  },
  {
    name: 'memphis_recall',
    tier: 0,
    capabilities: ['read'],
    exposures: ['native', 'gateway'],
  },
  {
    name: 'memphis_search',
    tier: 0,
    capabilities: ['read'],
    exposures: ['native', 'gateway'],
  },
  {
    name: 'memphis_self_modify',
    tier: 2,
    capabilities: ['write', 'execute'],
    exposures: ['native', 'gateway'],
  },
  {
    name: 'memphis_soul_read',
    tier: 0,
    capabilities: ['read'],
    exposures: ['native', 'gateway'],
  },
  {
    name: 'memphis_soul_write',
    tier: 0,
    capabilities: ['write'],
    exposures: ['native', 'gateway'],
  },
  {
    name: 'memphis_test',
    tier: 2,
    capabilities: ['execute'],
    exposures: ['native', 'gateway'],
  },
  {
    // Native-only: the gateway does not advertise it, but the native
    // surface executes it under the tier recorded here.
    //
    // Before this contract existed, this tool had a hand-written policy in
    // `native-tool-policy.ts` and was absent from `TOOL_REGISTRY`, so no
    // registry-driven check could see it.
    name: 'memphis_vault_list',
    tier: 0,
    capabilities: ['read'],
    exposures: ['native'],
    gatewayHidden: true,
  },
  {
    name: 'memphis_web_fetch',
    tier: 2,
    capabilities: ['network', 'read'],
    exposures: ['native', 'gateway'],
  },
];

const CONTRACT_BY_NAME = new Map(NATIVE_TOOL_CONTRACTS.map((c) => [c.name, c]));

/** Contract for a tool, or undefined when the tool is not in the contract. */
export function getToolContract(name: string): ToolContract | undefined {
  return CONTRACT_BY_NAME.get(name);
}

/** Names of every tool the native surface may execute. */
export function nativeToolContractNames(): string[] {
  return NATIVE_TOOL_CONTRACTS.filter((c) => c.exposures.includes('native')).map((c) => c.name);
}

/**
 * Contract for a tool that must exist. Throws when the tool is not in the
 * contract, so a caller that needs a real policy never silently gets a
 * default one.
 */
export function requireToolContract(name: string): ToolContract {
  const contract = CONTRACT_BY_NAME.get(name);
  if (!contract) {
    throw new Error(`Missing or invalid tool contract: ${name}`);
  }
  return contract;
}
