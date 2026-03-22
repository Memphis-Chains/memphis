/**
 * Tiered authorization module.
 *
 * Resolves tool policies by combining:
 *   1. Explicit SQLite policies (operator overrides — highest priority)
 *   2. Trust rules from soul manifest
 *   3. Mode + tier defaults (quiet/balanced/paranoid)
 */
import { getToolMeta, type ToolTier } from './tool-registry.js';
import type { CaseChainAdapter } from '../infra/storage/case-chain-adapter.js';
import type {
  SqliteToolPermissionRepository,
  ToolPolicy,
} from '../infra/storage/sqlite/repositories/tool-permission-repository.js';
import type { AutonomyMode, SoulManifest, TrustRule } from '../soul/types.js';

export type AuthorizationSource =
  | 'explicit-policy'
  | 'trust-rule'
  | 'mode-default'
  | 'unknown-tool';

export interface AuthorizationResult {
  policy: ToolPolicy;
  reason: string;
  tier: ToolTier;
  source: AuthorizationSource;
}

export interface AuthorizationContext {
  toolName: string;
  permissionRepo?: SqliteToolPermissionRepository;
  manifest: SoulManifest;
}

function applyModeDefaults(tier: ToolTier, mode: AutonomyMode): ToolPolicy {
  if (mode === 'quiet') {
    return tier <= 1 ? 'allow' : 'require-approval';
  }
  if (mode === 'balanced') {
    return tier === 0 ? 'allow' : 'require-approval';
  }
  // paranoid
  return 'require-approval';
}

function findMatchingRule(toolName: string, trustRules: TrustRule[]): TrustRule | undefined {
  return trustRules.find((r) => r.tool === toolName || r.tool === '*');
}

export function resolveToolPolicy(ctx: AuthorizationContext): AuthorizationResult {
  const meta = getToolMeta(ctx.toolName);

  // 1. Unknown tool → deny
  if (!meta) {
    return {
      policy: 'deny',
      reason: `Unknown tool: ${ctx.toolName}`,
      tier: 0,
      source: 'unknown-tool',
    };
  }

  // 2. Explicit SQLite policy (operator override) — highest priority
  if (ctx.permissionRepo) {
    const explicit = ctx.permissionRepo.get(ctx.toolName);
    if (explicit) {
      return {
        policy: explicit.policy,
        reason: `Explicit operator policy: ${explicit.policy}`,
        tier: meta.tier,
        source: 'explicit-policy',
      };
    }
  }

  // 3. Trust rules from manifest
  const rule = findMatchingRule(ctx.toolName, ctx.manifest.trustRules ?? []);
  if (rule) {
    const policy: ToolPolicy = rule.autoApprove ? 'allow' : 'require-approval';
    return {
      policy,
      reason: `Trust rule: ${rule.autoApprove ? 'auto-approve' : 'require-approval'}`,
      tier: meta.tier,
      source: 'trust-rule',
    };
  }

  // 4. Mode + tier defaults
  const mode = ctx.manifest.mode ?? 'balanced';
  const policy = applyModeDefaults(meta.tier, mode);
  return {
    policy,
    reason: `${mode} mode: tier${meta.tier} → ${policy}`,
    tier: meta.tier,
    source: 'mode-default',
  };
}

export async function recordAuthorizationDecision(
  toolName: string,
  decision: 'approved' | 'denied' | 'auto-approved',
  reason: string,
  caseAdapter: CaseChainAdapter,
): Promise<void> {
  try {
    await caseAdapter.appendCaseEntry({
      case_type: 'accusative',
      subject: 'operator',
      verb: decision,
      object: `${toolName}: ${reason}`,
    });
  } catch {
    // Best-effort audit — don't break tool execution
  }
}
