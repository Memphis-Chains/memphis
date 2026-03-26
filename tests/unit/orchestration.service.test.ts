import { describe, expect, it } from 'vitest';

import { OrchestrationService } from '../../src/modules/orchestration/service.js';
import { LocalFallbackProvider } from '../../src/providers/local-fallback/adapter.js';

describe('OrchestrationService', () => {
  it('uses default provider when provider=auto', async () => {
    const svc = new OrchestrationService({
      defaultProvider: 'local-fallback',
      providers: [new LocalFallbackProvider()],
    });

    const result = await svc.generate({ input: 'hello', provider: 'auto' });
    expect(result.providerUsed).toBe('local-fallback');
    expect(result.output).toContain('hello');
  });

  it('returns providers health list', async () => {
    const svc = new OrchestrationService({
      defaultProvider: 'local-fallback',
      providers: [new LocalFallbackProvider()],
    });

    const health = await svc.providersHealth();
    expect(health.length).toBe(1);
    expect(health[0]?.ok).toBe(true);
  });

  it('supports chat via the unified runtime adapter even for generate-only providers', async () => {
    const svc = new OrchestrationService({
      defaultProvider: 'local-fallback',
      providers: [new LocalFallbackProvider()],
    });

    const result = await svc.chat({
      provider: 'auto',
      messages: [{ role: 'user', content: 'hello from chat' }],
    });

    expect(result.providerUsed).toBe('local-fallback');
    expect(result.output).toContain('hello from chat');
  });
});
