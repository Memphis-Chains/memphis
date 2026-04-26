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
  isToolAllowedForSurface,
  resolveSurfacePolicy,
  type SurfacePolicy,
} from '../../gateway/surface-policy.js';
import { getToolMeta, getToolNames } from '../../gateway/tool-registry.js';
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
    asOf: new Date(now).toISOString(),
  };
}
