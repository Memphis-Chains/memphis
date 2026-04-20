/**
 * Centralized tool metadata registry.
 *
 * Single source of truth for tool names, tiers, capabilities, and feature gating.
 * Replaces the static KNOWN_TOOLS list in soul/manifest.ts.
 */

import { z } from 'zod';

import type { MemphisFeatureFlag } from '../infra/features/flags.js';
import { isFeatureFlagEnabled } from '../infra/features/flags.js';

export type ToolTier = 0 | 1 | 2 | 3;
export type ToolCapability = 'read' | 'write' | 'network' | 'execute';

export interface ToolMeta {
  name: string;
  tier: ToolTier;
  capabilities: ToolCapability[];
  description: string;
  featureFlag?: MemphisFeatureFlag;
  /**
   * Optional Zod schema describing the tool's input shape.
   *
   * When present, surfaces (TUI, GUI, MCP server, custom apps) can use it
   * to render forms, validate input before dispatch, and generate JSON
   * schema for LLM tool-call signatures. Pilot rollout: 5 tier-0 tools
   * (memphis_journal, memphis_recall, memphis_search, memphis_decide,
   * memphis_health). Migration of remaining 32 tool handlers is intentionally
   * deferred to keep the diff isolated to the registry.
   */
  inputSchema?: z.ZodTypeAny;
}

export const TOOL_REGISTRY: Record<string, ToolMeta> = {
  memphis_journal: {
    name: 'memphis_journal',
    tier: 0,
    capabilities: ['write'],
    description: 'Save entries to journal chain',
    inputSchema: z
      .object({
        content: z.string().min(1, 'content is required'),
        tags: z.array(z.string()).optional(),
        approval_request_id: z.string().optional(),
      })
      .strict(),
  },
  memphis_recall: {
    name: 'memphis_recall',
    tier: 0,
    capabilities: ['read'],
    description: 'Semantic search across chains',
    inputSchema: z
      .object({
        query: z.string().min(1, 'query is required'),
        // Aligned with src/mcp/server.ts memphis_recall validator: limit ≤ 50.
        limit: z.number().int().positive().max(50).optional(),
        approval_request_id: z.string().optional(),
      })
      .strict(),
  },
  memphis_search: {
    name: 'memphis_search',
    tier: 0,
    capabilities: ['read'],
    description: 'Exact phrase search across indexed memory',
    inputSchema: z
      .object({
        query: z.string().min(1, 'query is required'),
        // Aligned with src/mcp/server.ts memphis_search validator: limit ≤ 50,
        // chain is required non-empty when provided.
        limit: z.number().int().positive().max(50).optional(),
        chain: z.string().min(1).optional(),
        approval_request_id: z.string().optional(),
      })
      .strict(),
  },
  memphis_decide: {
    name: 'memphis_decide',
    tier: 0,
    capabilities: ['write'],
    description: 'Record decisions',
    inputSchema: z
      .object({
        title: z.string().min(1, 'title is required'),
        choice: z.string().min(1, 'choice is required'),
        context: z.string().optional(),
        approval_request_id: z.string().optional(),
      })
      .strict(),
  },
  memphis_health: {
    name: 'memphis_health',
    tier: 0,
    capabilities: ['read'],
    description: 'Check runtime health',
    inputSchema: z
      .object({
        approval_request_id: z.string().optional(),
      })
      .strict(),
  },
  memphis_repair: {
    name: 'memphis_repair',
    tier: 0,
    capabilities: ['write'],
    description:
      'Repair Memphis runtime state — chain integrity, SQLite, migrations, derived indexes',
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
  memphis_chain_query: {
    name: 'memphis_chain_query',
    tier: 0,
    capabilities: ['read'],
    description: 'Query raw chain blocks with lightweight filters',
    featureFlag: 'experimental-tools',
  },
  memphis_loop_step: {
    name: 'memphis_loop_step',
    tier: 0,
    capabilities: ['read'],
    description: 'Loop enforcement',
  },
  memphis_web_fetch: {
    name: 'memphis_web_fetch',
    tier: 2,
    capabilities: ['network', 'read'],
    description: 'Fetch public URL',
  },
  memphis_code_read: {
    name: 'memphis_code_read',
    tier: 2,
    capabilities: ['read'],
    description: 'Read files inside ~/memphis/ (whitelisted, read-only)',
  },
  memphis_grep: {
    name: 'memphis_grep',
    tier: 2,
    capabilities: ['read'],
    description: 'Search code using regex patterns (ripgrep or grep)',
  },
  memphis_glob: {
    name: 'memphis_glob',
    tier: 2,
    capabilities: ['read'],
    description: 'Find files by glob pattern (fd or find)',
  },
  memphis_git: {
    name: 'memphis_git',
    tier: 2,
    capabilities: ['read', 'write'],
    description: 'Git operations — all tier 2',
  },
  memphis_test: {
    name: 'memphis_test',
    tier: 2,
    capabilities: ['execute'],
    description: 'Run project tests (typecheck, lint, vitest, cargo test)',
  },
  memphis_deploy: {
    name: 'memphis_deploy',
    tier: 2,
    capabilities: ['execute', 'write', 'network'],
    description:
      'Run Memphis deploy, health, and rollback workflows with snapshots and post-checks',
  },
  memphis_cron: {
    name: 'memphis_cron',
    tier: 2,
    capabilities: ['execute', 'write'],
    description: 'Manage scheduled tasks (list, add, remove, enable, disable)',
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
  memphis_fs_write: {
    name: 'memphis_fs_write',
    tier: 2,
    capabilities: ['write'],
    description: 'Write or append to files inside ~/memphis/ (blocks sensitive paths)',
  },
  memphis_fs_ops: {
    name: 'memphis_fs_ops',
    tier: 2,
    capabilities: ['write'],
    description: 'Filesystem operations: copy, move, delete, mkdir, stat (sandboxed to ~/memphis/)',
  },
  memphis_web_search: {
    name: 'memphis_web_search',
    tier: 2,
    capabilities: ['network', 'read'],
    description: 'Search the web via DuckDuckGo (no API key needed)',
  },
  memphis_package: {
    name: 'memphis_package',
    tier: 2,
    capabilities: ['execute'],
    description: 'Package manager operations (npm, cargo, apt, pip)',
  },
  memphis_db: {
    name: 'memphis_db',
    tier: 2,
    capabilities: ['read', 'write'],
    description: 'Query and manage SQLite databases inside ~/memphis/',
  },
  memphis_build: {
    name: 'memphis_build',
    tier: 2,
    capabilities: ['execute'],
    description: 'Auto-detect project type and run build (npm, cargo, python)',
  },
  memphis_health_check: {
    name: 'memphis_health_check',
    tier: 1,
    capabilities: ['network'],
    description: 'HTTP health checks against one or more targets',
  },
  memphis_providers: {
    name: 'memphis_providers',
    tier: 0,
    capabilities: ['read'],
    description: 'Inspect configured providers, default models, and discovered model lists',
    featureFlag: 'experimental-tools',
  },
  memphis_system_info: {
    name: 'memphis_system_info',
    tier: 0,
    capabilities: ['read'],
    description: 'Inspect host and Memphis runtime system details',
    featureFlag: 'experimental-tools',
  },
  memphis_presence: {
    name: 'memphis_presence',
    tier: 0,
    capabilities: ['read'],
    description: 'Cross-surface presence snapshot (TUI / Telegram / HTTP)',
  },
  memphis_config_show: {
    name: 'memphis_config_show',
    tier: 0,
    capabilities: ['read'],
    description: 'Show current runtime config (redacted)',
  },
  memphis_config_reload: {
    name: 'memphis_config_reload',
    tier: 2,
    capabilities: ['write'],
    description: 'Re-read .env and hot-swap mutable fields',
  },
  memphis_restart: {
    name: 'memphis_restart',
    tier: 2,
    capabilities: ['write'],
    description: 'Request a self-restart (tier-3 session required)',
  },
  // Codex Round 5 P1 fix: these tools were registered in createMemphisMcpServer
  // but `isToolEnabledByFeatureFlag` returned false because they weren't in
  // the registry, so `shouldRegisterTool` rejected them silently. MCP clients
  // never saw them.
  memphis_config_set: {
    name: 'memphis_config_set',
    tier: 2,
    capabilities: ['write'],
    description:
      'Set a single config key/value. Cold fields refuse; secret fields require operator passphrase.',
  },
  memphis_cognitive_mode_set: {
    name: 'memphis_cognitive_mode_set',
    tier: 2,
    capabilities: ['write'],
    description: 'Switch cognitive mode (A–E). Requires operator passphrase.',
  },
};

export function getToolMeta(name: string): ToolMeta | undefined {
  return TOOL_REGISTRY[name];
}

export function isToolEnabledByFeatureFlag(
  name: string,
  rawEnv: NodeJS.ProcessEnv = process.env,
): boolean {
  const meta = getToolMeta(name);
  if (!meta) return false;
  return !meta.featureFlag || isFeatureFlagEnabled(meta.featureFlag, rawEnv);
}

export function getToolNames(rawEnv: NodeJS.ProcessEnv = process.env): string[] {
  return Object.values(TOOL_REGISTRY)
    .filter((tool) => isToolEnabledByFeatureFlag(tool.name, rawEnv))
    .map((tool) => tool.name);
}

export function getToolsByTier(
  tier: ToolTier,
  rawEnv: NodeJS.ProcessEnv = process.env,
): ToolMeta[] {
  return Object.values(TOOL_REGISTRY).filter(
    (tool) => tool.tier === tier && isToolEnabledByFeatureFlag(tool.name, rawEnv),
  );
}
