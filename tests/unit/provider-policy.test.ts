import { describe, expect, it } from 'vitest';

import { ProviderPolicy } from '../../src/modules/orchestration/provider-policy.js';

describe('ProviderPolicy', () => {
  it('marks cooldown after failure and clears on success', () => {
    const policy = new ProviderPolicy(1000);
    const now = 10000;

    policy.markFailure('shared-llm', now);
    expect(policy.isInCooldown('shared-llm', now + 10)).toBe(true);
    expect(policy.remainingCooldownMs('shared-llm', now + 10)).toBeGreaterThan(0);

    policy.markSuccess('shared-llm');
    expect(policy.isInCooldown('shared-llm', now + 10)).toBe(false);
  });
});
