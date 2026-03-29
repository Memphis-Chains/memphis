/**
 * Tier-Dependent Feature Gating
 *
 * Feature-based access control based on user authentication tier.
 * Restricts high-tier operations (provider-change, config-write, source-modify)
 * based on whether the operator has configured vault passphrase.
 *
 * Tier 0 (no auth): soul-memory, journal, recall, health, case-entries
 * Tier 1 (api_token): adds vault-secrets, config-write, provider-change, channel-config
 * Tier 2 (vault_passphrase): adds source-modify, tool-install, branch-create, snapshot
 */

import { isOperatorConfigured } from '../infra/auth/operator-gate.js';

// ─── Types ─────────────────────────────────────────────────────────────────

export type FeatureTier = 0 | 1 | 2;

export type FeatureName =
  | 'soul-memory'
  | 'journal'
  | 'recall'
  | 'health'
  | 'case-entries'
  | 'vault-secrets'
  | 'config-write'
  | 'provider-change'
  | 'channel-config'
  | 'source-modify'
  | 'tool-install'
  | 'branch-create'
  | 'snapshot';

export interface TierFeatureMap {
  allowed: readonly FeatureName[];
  denied: readonly FeatureName[];
}

// ─── Feature Map ───────────────────────────────────────────────────────────

export const TIER_FEATURES: Record<FeatureTier, TierFeatureMap> = {
  0: {
    allowed: ['soul-memory', 'journal', 'recall', 'health', 'case-entries'],
    denied: [
      'vault-secrets',
      'provider-change',
      'config-write',
      'source-modify',
      'tool-install',
      'branch-create',
      'snapshot',
    ],
  },
  1: {
    allowed: ['vault-secrets', 'config-write', 'provider-change', 'channel-config'],
    denied: ['source-modify', 'tool-install', 'branch-create', 'snapshot'],
  },
  2: {
    allowed: ['source-modify', 'tool-install', 'branch-create', 'snapshot'],
    denied: [],
  },
} as const;

// ─── User Tier Resolution ───────────────────────────────────────────────────

/**
 * Determines the user's tier based on authentication state.
 *
 * Tier 2: Operator passphrase configured (full access)
 * Tier 1: API token present (config + channel + provider access)
 * Tier 0: No authentication configured (basic read-only operations)
 *
 * Note: Tier 1 detection via API token is a placeholder for future implementation.
 * Currently only tier 2 (operator configured) vs tier 0 (not configured) is enforced.
 */
export function getUserTier(rawEnv: NodeJS.ProcessEnv = process.env): FeatureTier {
  if (isOperatorConfigured(rawEnv)) {
    return 2;
  }

  // TODO: Check for API token presence for tier 1
  // if (rawEnv.MEMPHIS_API_TOKEN) return 1;

  return 0;
}

// ─── Feature Check ──────────────────────────────────────────────────────────

/**
 * Checks if a feature is allowed for the given user tier.
 *
 * Resolution order:
 * 1. If feature is explicitly denied for tier → denied
 * 2. If feature is explicitly allowed for tier → allowed
 * 3. If feature is not listed (implicit) → denied (fail-closed)
 */
export function requireTier(feature: FeatureName, userTier: FeatureTier): 'allowed' | 'denied' {
  const tierConfig = TIER_FEATURES[userTier];

  if (tierConfig.denied.includes(feature)) {
    return 'denied';
  }

  if (tierConfig.allowed.includes(feature)) {
    return 'allowed';
  }

  // Feature not in explicit lists → fail closed (deny by default)
  return 'denied';
}

/**
 * Requires a feature and throws if denied.
 * Use this for gating CLI commands or API routes.
 *
 * @throws Error with descriptive message if feature is denied
 */
export function enforceTierFeature(
  feature: FeatureName,
  userTier: FeatureTier,
  operationName?: string,
): void {
  const result = requireTier(feature, userTier);
  if (result === 'denied') {
    const tierNames: Record<FeatureTier, string> = {
      0: 'unauthenticated (Tier 0)',
      1: 'API token (Tier 1)',
      2: 'operator passphrase (Tier 2)',
    };
    const op = operationName ?? feature;
    throw new Error(
      `Feature '${op}' requires higher access tier. ` +
        `Current: ${tierNames[userTier]}. ` +
        `Required: see TIER_FEATURES for ${feature} tier requirements.`,
    );
  }
}

/**
 * Returns all features available to a given tier.
 */
export function getAvailableFeatures(userTier: FeatureTier): readonly FeatureName[] {
  return TIER_FEATURES[userTier].allowed;
}

/**
 * Checks if a feature requires a specific tier (minimum tier).
 */
export function getMinimumTierForFeature(feature: FeatureName): FeatureTier {
  for (let tier = 0; tier <= 2; tier++) {
    if (requireTier(feature, tier as FeatureTier) === 'allowed') {
      return tier as FeatureTier;
    }
  }
  return 2; // Default to highest tier if not found
}
