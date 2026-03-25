/**
 * Centralized tool metadata registry.
 *
 * Single source of truth for tool names, tiers, and capabilities.
 * Replaces the static KNOWN_TOOLS list in soul/manifest.ts.
 */

export type ToolTier = 0 | 1 | 2;
export type ToolCapability = 'read' | 'write' | 'network' | 'execute';

export interface ToolMeta {
  name: string;
  tier: ToolTier;
  capabilities: ToolCapability[];
  description: string;
}

export const TOOL_REGISTRY: Record<string, ToolMeta> = {
  memphis_journal: {
    name: 'memphis_journal',
    tier: 0,
    capabilities: ['write'],
    description: 'Save entries to journal chain',
  },
  memphis_recall: {
    name: 'memphis_recall',
    tier: 0,
    capabilities: ['read'],
    description: 'Semantic search across chains',
  },
  memphis_decide: {
    name: 'memphis_decide',
    tier: 0,
    capabilities: ['write'],
    description: 'Record decisions',
  },
  memphis_health: {
    name: 'memphis_health',
    tier: 0,
    capabilities: ['read'],
    description: 'Check runtime health',
  },
  memphis_soul_read: {
    name: 'memphis_soul_read',
    tier: 0,
    capabilities: ['read'],
    description: 'Read soul memory',
  },
  memphis_soul_write: {
    name: 'memphis_soul_write',
    tier: 0,
    capabilities: ['write'],
    description: 'Update soul memory',
  },
  memphis_case_append: {
    name: 'memphis_case_append',
    tier: 0,
    capabilities: ['write'],
    description: 'Append case entry',
  },
  memphis_case_query: {
    name: 'memphis_case_query',
    tier: 0,
    capabilities: ['read'],
    description: 'Query case graph',
  },
  memphis_loop_step: {
    name: 'memphis_loop_step',
    tier: 0,
    capabilities: ['read'],
    description: 'Loop enforcement',
  },
  memphis_web_fetch: {
    name: 'memphis_web_fetch',
    tier: 1,
    capabilities: ['network', 'read'],
    description: 'Fetch public URL',
  },
  memphis_exec: {
    name: 'memphis_exec',
    tier: 2,
    capabilities: ['execute'],
    description: 'Execute shell command',
  },
  memphis_self_modify: {
    name: 'memphis_self_modify',
    tier: 2,
    capabilities: ['write', 'execute'],
    description: 'Safe self-modification with snapshot, branch isolation, and test gate',
  },
};

export function getToolMeta(name: string): ToolMeta | undefined {
  return TOOL_REGISTRY[name];
}

export function getToolNames(): string[] {
  return Object.keys(TOOL_REGISTRY);
}

export function getToolsByTier(tier: ToolTier): ToolMeta[] {
  return Object.values(TOOL_REGISTRY).filter((t) => t.tier === tier);
}
