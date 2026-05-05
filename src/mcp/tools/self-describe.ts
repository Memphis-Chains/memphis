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
import { getToolMeta, getToolNames, type ToolCliFlag } from '../../gateway/tool-registry.js';
import { listEnabledFeatureFlags } from '../../infra/features/flags.js';
import { getRecentBlocks } from '../../infra/storage/rust-chain-adapter.js';
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
   * Recent operator config-change events from the journal chain
   * (last 30 entries, last 30 days). Each `configure`-class CLI
   * (e.g. `memphis brave configure`, `memphis openai configure`,
   * `memphis telegram configure`) writes a journal block tagged
   * `config-change`. This list is the live, authoritative answer to
   * "co operator ostatnio włączył / what's been configured" — bot
   * should read it instead of guessing or relying on chain_hits.
   *
   * Empty array when no config-change events exist within the
   * window or when chain reads fail (best-effort, never throws).
   */
  recentConfigChanges: Array<{
    timestamp: string;
    /** Capability tag (e.g. 'brave-search', 'openai', 'telegram'). */
    capability: string;
    /** Block index for trace-back (`journal#<index>`). */
    blockIndex: number;
    /** First ~140 chars of the journal entry content. */
    summary: string;
    /** Other tags on the same block (provider/external-api/etc.). */
    tags: string[];
  }>;
  asOf: string;
}

/**
 * Window for `recentConfigChanges` — entries older than this are
 * dropped from the response. Configurable so a future env override
 * can stretch the window for ops triage. 30 days picks up most
 * "rotated my key last month, did Memphis pick it up?" workflows.
 */
const CONFIG_CHANGE_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;
const CONFIG_CHANGE_MAX_ENTRIES = 30;

interface ConfigChangeBlock {
  data?: {
    content?: string;
    tags?: string[];
    type?: string;
  };
  index?: number;
  timestamp?: string;
}

function deriveCapabilityTag(tags: readonly string[]): string {
  // Capability tag is the first tag that isn't 'config-change' or
  // a generic role tag. Operators tag entries like
  // ['config-change', 'brave-search', 'external-api'] — we surface
  // 'brave-search' as the capability label.
  const generic = new Set(['config-change', 'external-api', 'provider']);
  for (const tag of tags) {
    if (!generic.has(tag)) return tag;
  }
  return tags[0] ?? 'unknown';
}

async function readRecentConfigChanges(
  rawEnv: NodeJS.ProcessEnv,
): Promise<MemphisSelfDescribeOutput['recentConfigChanges']> {
  let blocks: ConfigChangeBlock[];
  try {
    // Read more than we need so the tag filter has plenty to cut
    // through — journal sees high write volume and config-change
    // blocks are sparse.
    blocks = (await getRecentBlocks('journal', 200, rawEnv)) as ConfigChangeBlock[];
  } catch {
    // Best-effort. Never throw from self-describe — operators rely
    // on it for ground truth, and a missing config-change list is
    // strictly less useful than a non-empty answer.
    return [];
  }

  const cutoff = Date.now() - CONFIG_CHANGE_WINDOW_MS;
  const out: MemphisSelfDescribeOutput['recentConfigChanges'] = [];
  // Walk newest → oldest so the slice keeps the most recent entries.
  for (let i = blocks.length - 1; i >= 0 && out.length < CONFIG_CHANGE_MAX_ENTRIES; i -= 1) {
    const block = blocks[i];
    const tags = block.data?.tags;
    if (!Array.isArray(tags) || !tags.includes('config-change')) continue;

    const ts = block.timestamp ? Date.parse(block.timestamp) : NaN;
    if (Number.isFinite(ts) && ts < cutoff) continue;

    const content = (block.data?.content ?? '').toString();
    out.push({
      timestamp: block.timestamp ?? new Date(0).toISOString(),
      capability: deriveCapabilityTag(tags),
      blockIndex: typeof block.index === 'number' ? block.index : -1,
      summary: content.length > 140 ? `${content.slice(0, 137)}…` : content,
      tags: [...tags],
    });
  }
  return out;
}

export async function runMemphisSelfDescribe(
  input: MemphisSelfDescribeInput = {},
  rawEnv: NodeJS.ProcessEnv = process.env,
): Promise<MemphisSelfDescribeOutput> {
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

  const recentConfigChanges = await readRecentConfigChanges(rawEnv);

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
    recentConfigChanges,
    asOf: new Date(now).toISOString(),
  };
}
