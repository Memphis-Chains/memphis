import { describe, it, expect, beforeEach, vi } from 'vitest';

import type { ProviderName } from '../../src/core/types.js';
import { OrchestrationService } from '../../src/modules/orchestration/service.js';
import type { RuntimeProvider } from '../../src/providers/runtime.js';

// Mock providers
function createMockProvider(name: ProviderName): RuntimeProvider {
  return {
    name,
    isConfigured: () => true,
    isAvailable: async () => true,
    listModels: async () => ['model-1'],
    defaultModel: () => 'model-1',
    healthCheck: async () => ({ name, ok: true }),
    chat: vi.fn(),
    generate: vi.fn(async () => ({
      id: 'test-id',
      providerUsed: name,
      output: 'test output',
      timingMs: 100,
    })),
  };
}

describe('Provider Cascade', () => {
  let orchestration: OrchestrationService;
  let deepseekProvider: RuntimeProvider;
  let ollamaProvider: RuntimeProvider;
  let fallbackProvider: RuntimeProvider;

  beforeEach(() => {
    deepseekProvider = createMockProvider('deepseek');
    ollamaProvider = createMockProvider('ollama');
    fallbackProvider = createMockProvider('local-fallback');

    orchestration = new OrchestrationService({
      defaultProvider: 'deepseek',
      providers: [deepseekProvider, ollamaProvider, fallbackProvider],
      providerCooldownMs: 5000,
    });
  });

  describe('Tier 1: Requested provider available', () => {
    it('returns requested provider with no degradation', () => {
      const result = orchestration.getCascadeResult('deepseek');

      expect(result.degraded).toBe(false);
      expect(result.tier).toBe(1);
      expect(result.originalRequested).toBe('deepseek');
      expect(result.actualProvider).toBe('deepseek');
      expect(result.provider.name).toBe('deepseek');
      expect(result.reason).toBeUndefined();
    });

    it('works with ollama as requested provider', () => {
      const result = orchestration.getCascadeResult('ollama');

      expect(result.degraded).toBe(false);
      expect(result.tier).toBe(1);
      expect(result.actualProvider).toBe('ollama');
    });
  });

  describe('Tier 2: Cascade to default provider', () => {
    it('cascades when requested provider in cooldown', async () => {
      // Trigger cooldown by causing a failure
      const policy = (orchestration as any).providerPolicy;
      policy.markFailure('ollama');

      const result = orchestration.getCascadeResult('ollama');

      expect(result.degraded).toBe(true);
      expect(result.tier).toBe(2);
      expect(result.originalRequested).toBe('ollama');
      expect(result.actualProvider).toBe('deepseek'); // default provider
      expect(result.reason).toBeDefined();
      expect(result.reason).toContain('cooldown');
    });

    it('cascades when requested provider unavailable', () => {
      const result = orchestration.getCascadeResult('minimax' as ProviderName);

      expect(result.degraded).toBe(true);
      expect(result.tier).toBe(2);
      expect(result.originalRequested).toBe('minimax');
      expect(result.actualProvider).toBe('deepseek');
      expect(result.reason).toContain('unavailable');
    });
  });

  describe('Tier 3: Cascade to ollama', () => {
    it('cascades to ollama when default also down', () => {
      const policy = (orchestration as any).providerPolicy;
      policy.markFailure('deepseek'); // default in cooldown

      const result = orchestration.getCascadeResult('minimax' as ProviderName);

      expect(result.degraded).toBe(true);
      expect(result.tier).toBe(4);
      expect(result.originalRequested).toBe('minimax');
      expect(result.actualProvider).toBe('ollama');
      expect(result.reason).toContain('unavailable');
    });
  });

  describe('Tier 5: Cascade to local-fallback', () => {
    it('cascades to local-fallback when everything down', () => {
      const policy = (orchestration as any).providerPolicy;
      policy.markFailure('deepseek');
      policy.markFailure('ollama');

      const result = orchestration.getCascadeResult('minimax' as ProviderName);

      expect(result.degraded).toBe(true);
      expect(result.tier).toBe(5);
      expect(result.originalRequested).toBe('minimax');
      expect(result.actualProvider).toBe('local-fallback');
      expect(result.reason).toContain('all providers unavailable');
    });

    it('always succeeds with local-fallback', () => {
      const policy = (orchestration as any).providerPolicy;
      // Put all providers in cooldown
      policy.markFailure('deepseek');
      policy.markFailure('ollama');
      policy.markFailure('minimax');

      const result = orchestration.getCascadeResult('deepseek');

      expect(result.provider.name).toBe('local-fallback');
      expect(result.tier).toBe(5);
    });
  });

  describe('Recovery detection', () => {
    it('returns tier 1 after provider recovers', () => {
      const policy = (orchestration as any).providerPolicy;
      policy.markFailure('ollama');

      // First call - degraded
      const degraded = orchestration.getCascadeResult('ollama');
      expect(degraded.degraded).toBe(true);

      // Mark success to clear cooldown
      policy.markSuccess('ollama');

      // Second call - recovered
      const recovered = orchestration.getCascadeResult('ollama');
      expect(recovered.degraded).toBe(false);
      expect(recovered.tier).toBe(1);
      expect(recovered.actualProvider).toBe('ollama');
    });
  });

  describe('resolveRuntimeProvider uses cascade internally', () => {
    it('returns provider from tier 1', () => {
      const provider = orchestration.resolveRuntimeProvider('deepseek');

      expect(provider.name).toBe('deepseek');
    });

    it('returns provider from tier 2 when tier 1 fails', () => {
      const policy = (orchestration as any).providerPolicy;
      policy.markFailure('ollama');

      const provider = orchestration.resolveRuntimeProvider('ollama');

      expect(provider.name).toBe('deepseek'); // cascaded to default
    });

    it('never throws - always returns a provider', () => {
      const policy = (orchestration as any).providerPolicy;
      policy.markFailure('deepseek');
      policy.markFailure('ollama');

      // Should not throw
      const provider = orchestration.resolveRuntimeProvider('minimax' as ProviderName);

      expect(provider.name).toBe('local-fallback');
    });
  });

  describe('Security: Provider name validation', () => {
    it('rejects malicious provider names', () => {
      const result = orchestration.getCascadeResult('../../etc/passwd' as ProviderName);

      // Should immediately fall back to safe default
      expect(result.actualProvider).toBe('local-fallback');
      // Tier 1 because local-fallback is available
      expect(result.tier).toBe(1);
    });

    it('sanitizes degradation reasons', () => {
      const policy = (orchestration as any).providerPolicy;
      policy.markFailure('deepseek');

      const result = orchestration.getCascadeResult('deepseek');

      expect(result.reason).toBeDefined();
      // Should not contain ANSI sequences
      expect(result.reason).not.toContain('\x1b');
      // Should not contain control characters
      expect(result.reason).not.toContain('\x00');
    });
  });
});
