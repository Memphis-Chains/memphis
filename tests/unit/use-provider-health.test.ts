import { describe, expect, test } from 'vitest';
import { useProviderHealth } from '../../src/tui/hooks/use-provider-health.js';

describe('useProviderHealth', () => {
  test('tracks provider health status', async () => {
    const result = await useProviderHealth('openai-compatible');
    expect(result.status).toBe('healthy');
    expect(result.latency).toBeGreaterThan(0);
  });

  test('detects provider failures', async () => {
    const result = await useProviderHealth('invalid-provider');
    expect(result.status).toBe('unhealthy');
    expect(result.error).toBeDefined();
  });
});
