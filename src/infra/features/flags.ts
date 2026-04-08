export const MEMPHIS_FEATURE_FLAGS = [
  'experimental-tools',
  'cloud',
  'offsec',
  'marketplace',
] as const;

export type MemphisFeatureFlag = (typeof MEMPHIS_FEATURE_FLAGS)[number];

const FEATURE_FLAG_ALIAS_MAP: Record<string, MemphisFeatureFlag> = {
  '*': 'experimental-tools',
  all: 'experimental-tools',
  experimental: 'experimental-tools',
  'experimental-tools': 'experimental-tools',
  labs: 'experimental-tools',
  cloud: 'cloud',
  iac: 'cloud',
  offsec: 'offsec',
  offensive: 'offsec',
  security: 'offsec',
  marketplace: 'marketplace',
  skills: 'marketplace',
};

export function normalizeFeatureFlag(value: string): MemphisFeatureFlag | undefined {
  return FEATURE_FLAG_ALIAS_MAP[value.trim().toLowerCase()];
}

export function parseFeatureFlags(
  rawEnv: NodeJS.ProcessEnv = process.env,
): Set<MemphisFeatureFlag> {
  const raw = rawEnv.MEMPHIS_FEATURES;
  if (!raw || raw.trim().length === 0) {
    return new Set();
  }

  const enabled = new Set<MemphisFeatureFlag>();
  for (const token of raw.split(/[,\s]+/u)) {
    if (!token) continue;
    const normalized = normalizeFeatureFlag(token);
    if (normalized) {
      enabled.add(normalized);
    }
  }
  return enabled;
}

export function isFeatureFlagEnabled(
  flag: MemphisFeatureFlag,
  rawEnv: NodeJS.ProcessEnv = process.env,
): boolean {
  return parseFeatureFlags(rawEnv).has(flag);
}

export function listEnabledFeatureFlags(
  rawEnv: NodeJS.ProcessEnv = process.env,
): MemphisFeatureFlag[] {
  return Array.from(parseFeatureFlags(rawEnv)).sort();
}
