/**
 * `memphis_self_describe` — runtime self-introspection.
 *
 * Surfaced after a 2026-04-26 operator session where the bot answered
 * "I see no tier-3 tools — tier 3 isn't useful" and "I have only tier 0
 * tools" while running with `maxToolTier=2`. The bot was hallucinating
 * its capabilities from training data instead of reading runtime state.
 *
 * This helper returns a structured snapshot the LLM (and operator-facing
 * surfaces) can rely on:
 *
 *   - active surface name + policy (maxToolTier, allow flags)
 *   - effective tier (with active tier-3 session info if any)
 *   - cognitive mode + config
 *   - full availableTools list with name + tier + capabilities + featureFlag
 *   - active feature flags (MEMPHIS_FEATURES)
 *   - cross-surface tier-3 sessions snapshot (PR #282 helper)
 *
 * Privacy: NO secret values; only structure + tier classifications.
 * The returned data is safe to render in operator-facing surfaces and
 * to feed back into the system prompt.
 */

import { getCognitiveModeConfig, type CognitiveMode } from '../../cognitive/modes.js';
import {
  MEMPHIS_BRAVE_SEARCH_TIMEOUT_MS,
  MEMPHIS_BUILD_TIMEOUT_MS,
  MEMPHIS_CATEGORIZER_LLM_TIMEOUT_MS,
  MEMPHIS_CHAT_MAX_MESSAGES,
  MEMPHIS_EXEC_TIMEOUT_MS,
  MEMPHIS_GEN_MAX_TOKENS,
  MEMPHIS_GEN_TIMEOUT_MS,
  MEMPHIS_LOOP_MAX_ERRORS,
  MEMPHIS_LOOP_MAX_STEPS,
  MEMPHIS_LOOP_MAX_TOOL_CALLS,
  MEMPHIS_PACKAGE_TIMEOUT_MS,
  MEMPHIS_PIPER_HEALTH_TIMEOUT_MS,
  MEMPHIS_STT_TIMEOUT_MS,
  MEMPHIS_TTS_TIMEOUT_MS,
  MEMPHIS_WEB_FETCH_TIMEOUT_MS,
  MEMPHIS_WEB_SEARCH_TIMEOUT_MS,
  MINIMAX_REQUEST_TIMEOUT_MS,
} from '../../config/env-registry.js';
import {
  isToolAllowedForSurface,
  resolveSurfacePolicy,
  type SurfacePolicy,
} from '../../gateway/surface-policy.js';
import { getToolMeta, getToolNames, type ToolCliFlag } from '../../gateway/tool-registry.js';
import { listEnabledFeatureFlags } from '../../infra/features/flags.js';
import {
  getActiveTier3Session,
  listActiveTier3Sessions,
} from '../../security/tier3-session.js';
import { getCognitiveMode } from '../../soul/manifest.js';

export interface MemphisSelfDescribeInput {
  /** Override surface name. Defaults to `'mcp'` when called from MCP server. */
  surface?: string;
  /** Actor id used for tier-3 lookup on the resolved surface. Defaults `'local'`. */
  actorId?: string;
}

export interface MemphisSelfDescribeOutput {
  surface: string;
  surfacePolicy: SurfacePolicy;
  effectiveTier: 0 | 1 | 2 | 3;
  tier3Session: {
    surface: string;
    actorId: string;
    grantedAt: string;
    expiresAt: string;
    remainingMs: number;
  } | null;
  cognitive: {
    mode: CognitiveMode;
    name: string;
    temperature: number;
    style: string;
    pattern: string;
    description: string;
  };
  tools: Array<{
    name: string;
    tier: 0 | 1 | 2 | 3;
    capabilities: string[];
    description: string;
    /**
     * Operator-facing rich help text (Sprint E Phase 1+2). Multi-
     * sentence detail surfaces in `memphis tools describe <name>`,
     * TUI `?` overlay, Telegram `/help <tool>`. Optional — tools
     * without helpText fall back to `description` at the surface.
     */
    helpText?: string;
    /**
     * Declarative CLI flag list (Sprint E Phase 1+2). When present,
     * `memphis tools describe` renders an aligned `--flag # desc`
     * block below the helpText. Optional — same fallback rule.
     */
    cliFlags?: readonly ToolCliFlag[];
    featureFlag: string | null;
    available: boolean;
  }>;
  toolsAvailable: number;
  toolsRegistered: number;
  featureFlags: string[];
  activeTier3SessionsAcrossSurfaces: Array<{
    surface: string;
    actorId: string;
    grantedAt: string;
    expiresAt: string;
    remainingMs: number;
  }>;
  /**
   * Phase 1.5.4 (autopilot 2026-05-08): effective runtime limits resolved
   * via env-registry. Each entry surfaces the resolved value, the env-key
   * that produced it (or 'default' if none), and the layer that enforces
   * it (Rust loop_engine vs TS host vs MCP tool). Operator-facing answer
   * to "is GEN_MAX_TOKENS=8192 actually plumbed?" without opening a
   * doctor/inspect detour.
   */
  limits: Array<{
    name: string;
    value: number;
    source: 'env' | 'default';
    enforcer: 'rust-core' | 'rust-operator' | 'ts-host' | 'mcp-tool';
  }>;
  asOf: string;
}

export function runMemphisSelfDescribe(
  input: MemphisSelfDescribeInput = {},
  rawEnv: NodeJS.ProcessEnv = process.env,
): MemphisSelfDescribeOutput {
  const surface = input.surface ?? 'mcp';
  const actorId = input.actorId ?? 'local';
  const policy = resolveSurfacePolicy(surface, rawEnv);

  const tier3 = getActiveTier3Session(
    surface as Parameters<typeof getActiveTier3Session>[0],
    actorId,
    rawEnv,
  );
  const now = Date.now();

  const effectiveTier = (tier3 ? 3 : policy.maxToolTier) as 0 | 1 | 2 | 3;

  const mode = (getCognitiveMode(rawEnv) ?? 'A') as CognitiveMode;
  const modeConfig = getCognitiveModeConfig(mode);

  const allRegistered = getToolNames(rawEnv);
  const toolsRegistered = allRegistered.length;

  const tools = allRegistered.map((name) => {
    const meta = getToolMeta(name);
    const available = meta ? isToolAllowedForSurface(name, policy) : false;
    return {
      name,
      tier: (meta?.tier ?? 0) as 0 | 1 | 2 | 3,
      capabilities: meta?.capabilities ?? [],
      description: meta?.description ?? '',
      // Sprint E Phase 2: surface helpText + cliFlags through the
      // capabilities envelope so `memphis tools describe` (CLI),
      // future TUI `?` overlay, and Telegram `/help <tool>` can
      // render the richer text without each surface re-importing
      // tool-registry. Undefined when the tool hasn't been migrated
      // yet — surfaces fall back to `description`.
      helpText: meta?.helpText,
      cliFlags: meta?.cliFlags,
      featureFlag: meta?.featureFlag ?? null,
      available,
    };
  });
  const toolsAvailable = tools.filter((t) => t.available).length;

  const tier3SessionView = tier3
    ? {
        surface: tier3.surface,
        actorId: tier3.actorId,
        grantedAt: new Date(tier3.grantedAt).toISOString(),
        expiresAt: new Date(tier3.expiresAt).toISOString(),
        remainingMs: Math.max(0, tier3.expiresAt - now),
      }
    : null;

  const acrossSurfaces = listActiveTier3Sessions(rawEnv).map((s) => ({
    surface: s.surface,
    actorId: s.actorId,
    grantedAt: new Date(s.grantedAt).toISOString(),
    expiresAt: new Date(s.expiresAt).toISOString(),
    remainingMs: Math.max(0, s.expiresAt - now),
  }));

  return {
    surface,
    surfacePolicy: policy,
    effectiveTier,
    tier3Session: tier3SessionView,
    cognitive: {
      mode,
      name: modeConfig.name,
      temperature: modeConfig.temperature,
      style: modeConfig.style,
      pattern: modeConfig.pattern,
      description: modeConfig.description,
    },
    tools,
    toolsAvailable,
    toolsRegistered,
    featureFlags: listEnabledFeatureFlags(rawEnv),
    activeTier3SessionsAcrossSurfaces: acrossSurfaces,
    limits: collectLimitsSnapshot(rawEnv),
    asOf: new Date(now).toISOString(),
  };
}

/**
 * Phase 1.5.4: surface every limit accessor that LIMITS-MATRIX-2026-05-08
 * catalogued. Operator asking "is MEMPHIS_GEN_MAX_TOKENS=8192 actually in
 * effect?" sees the answer in self-describe instead of grepping config.
 *
 * Layer attribution lets the LLM read off the right enforcer when
 * explaining a halt: loop max-steps comes from Rust loop_engine, tool
 * timeouts come from MCP tool wrappers, etc.
 */
function collectLimitsSnapshot(rawEnv: NodeJS.ProcessEnv): Array<{
  name: string;
  value: number;
  source: 'env' | 'default';
  enforcer: 'rust-core' | 'rust-operator' | 'ts-host' | 'mcp-tool';
}> {
  const entries: Array<{
    accessor: { name: string; read(env: NodeJS.ProcessEnv): number; inspect(env: NodeJS.ProcessEnv): { source: 'env' | 'default' } };
    enforcer: 'rust-core' | 'rust-operator' | 'ts-host' | 'mcp-tool';
  }> = [
    { accessor: MEMPHIS_LOOP_MAX_STEPS, enforcer: 'rust-core' },
    { accessor: MEMPHIS_LOOP_MAX_TOOL_CALLS, enforcer: 'rust-core' },
    { accessor: MEMPHIS_LOOP_MAX_ERRORS, enforcer: 'rust-core' },
    { accessor: MEMPHIS_CHAT_MAX_MESSAGES, enforcer: 'rust-operator' },
    { accessor: MEMPHIS_GEN_TIMEOUT_MS, enforcer: 'ts-host' },
    { accessor: MEMPHIS_GEN_MAX_TOKENS, enforcer: 'rust-operator' },
    { accessor: MINIMAX_REQUEST_TIMEOUT_MS, enforcer: 'ts-host' },
    { accessor: MEMPHIS_STT_TIMEOUT_MS, enforcer: 'ts-host' },
    { accessor: MEMPHIS_TTS_TIMEOUT_MS, enforcer: 'ts-host' },
    { accessor: MEMPHIS_PIPER_HEALTH_TIMEOUT_MS, enforcer: 'ts-host' },
    { accessor: MEMPHIS_EXEC_TIMEOUT_MS, enforcer: 'mcp-tool' },
    { accessor: MEMPHIS_BUILD_TIMEOUT_MS, enforcer: 'mcp-tool' },
    { accessor: MEMPHIS_PACKAGE_TIMEOUT_MS, enforcer: 'mcp-tool' },
    { accessor: MEMPHIS_WEB_FETCH_TIMEOUT_MS, enforcer: 'mcp-tool' },
    { accessor: MEMPHIS_BRAVE_SEARCH_TIMEOUT_MS, enforcer: 'mcp-tool' },
    { accessor: MEMPHIS_WEB_SEARCH_TIMEOUT_MS, enforcer: 'mcp-tool' },
    { accessor: MEMPHIS_CATEGORIZER_LLM_TIMEOUT_MS, enforcer: 'ts-host' },
  ];
  return entries.map(({ accessor, enforcer }) => ({
    name: accessor.name,
    value: accessor.read(rawEnv),
    source: accessor.inspect(rawEnv).source,
    enforcer,
  }));
}
