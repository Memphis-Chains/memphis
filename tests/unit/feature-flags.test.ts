import { describe, expect, it } from 'vitest';

import { envSchema } from '../../src/infra/config/schema.js';
import {
  isFeatureFlagEnabled,
  listEnabledFeatureFlags,
  normalizeFeatureFlag,
  parseFeatureFlags,
} from '../../src/infra/features/flags.js';

describe('feature flags', () => {
  it('parses MEMPHIS_FEATURES with aliases and ignores unknown values', () => {
    const flags = parseFeatureFlags({
      MEMPHIS_FEATURES: 'experimental, offsec, unknown-flag, marketplace',
    });

    expect(Array.from(flags).sort()).toEqual(['experimental-tools', 'marketplace', 'offsec']);
  });

  it('supports direct flag checks and normalized aliases', () => {
    expect(normalizeFeatureFlag('experimental')).toBe('experimental-tools');
    expect(normalizeFeatureFlag('iac')).toBe('cloud');
    expect(normalizeFeatureFlag('nope')).toBeUndefined();
    expect(isFeatureFlagEnabled('experimental-tools', { MEMPHIS_FEATURES: 'labs' })).toBe(true);
    expect(listEnabledFeatureFlags({ MEMPHIS_FEATURES: 'offsec cloud' })).toEqual([
      'cloud',
      'offsec',
    ]);
  });

  it('accepts MEMPHIS_FEATURES in the validated env schema', () => {
    const result = envSchema.safeParse({
      MEMPHIS_FEATURES: 'experimental-tools,offsec',
    });

    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.MEMPHIS_FEATURES).toBe('experimental-tools,offsec');
  });
});
