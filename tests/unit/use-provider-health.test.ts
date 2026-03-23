import { describe, expect, test } from 'vitest';

import { useProviderHealth } from '../../src/tui/hooks/use-provider-health.js';

describe('useProviderHealth', () => {
  test('returns unknown for unwired providers', async () => {
    const result = await useProviderHealth('openai-compatible');
    expect(result.status).toBe('unknown');
  });

  test('detects provider failures', async () => {
    const result = await useProviderHealth('invalid-provider');
    expect(result.status).toBe('unhealthy');
    expect(result.error).toBeDefined();
  });
});
