import { describe, expect, it } from 'vitest';

import type { LLMProvider } from '../../src/core/contracts/llm-provider.js';
import type { ProviderName } from '../../src/core/types.js';
import { OrchestrationService } from '../../src/modules/orchestration/service.js';

function fakeProvider(name: ProviderName): LLMProvider {
  return {
    name,
    defaultModel: () => `${name}-model`,
    listModels: async () => [`${name}-model`],
    health: async () => ({ ok: true, provider: name }),
    generate: async () => ({
      content: 'ok',
      model: `${name}-model`,
      provider: name,
    }),
  } as unknown as LLMProvider;
}

function makeService(initialDefault: ProviderName): OrchestrationService {
  return new OrchestrationService({
    defaultProvider: initialDefault,
    providers: [
      fakeProvider('anthropic'),
      fakeProvider('minimax'),
      fakeProvider('ollama'),
      fakeProvider('local-fallback'),
    ],
  });
}

describe('OrchestrationService — default provider hot-swap', () => {
  it('exposes the construction-time default via getDefaultProvider', () => {
    const svc = makeService('anthropic');
    expect(svc.getDefaultProvider()).toBe('anthropic');
  });

  it('setDefaultProvider replaces the cached default and reports the change', () => {
    const svc = makeService('anthropic');
    const result = svc.setDefaultProvider('minimax');
    expect(result.changed).toBe(true);
    expect(result.previous).toBe('anthropic');
    expect(result.next).toBe('minimax');
    expect(svc.getDefaultProvider()).toBe('minimax');
  });

  it('reports changed=false when the new value equals the current one', () => {
    const svc = makeService('anthropic');
    const result = svc.setDefaultProvider('anthropic');
    expect(result.changed).toBe(false);
    expect(svc.getDefaultProvider()).toBe('anthropic');
  });

  it('rejects unknown provider names with a validation error', () => {
    const svc = makeService('anthropic');
    expect(() => svc.setDefaultProvider('not-a-real-provider')).toThrow(/unknown provider/);
    expect(svc.getDefaultProvider()).toBe('anthropic');
  });

  it('rejects known names that are not registered in this runtime', () => {
    // shared-llm is in PROVIDER_NAMES but not provided to this service
    const svc = makeService('anthropic');
    expect(() => svc.setDefaultProvider('shared-llm')).toThrow(/not registered in this runtime/);
    expect(svc.getDefaultProvider()).toBe('anthropic');
  });

  it('next provider lookup uses the swapped default (resolveProvider strategy=default)', () => {
    const svc = makeService('anthropic');
    expect(svc.resolveProvider('auto').name).toBe('anthropic');
    svc.setDefaultProvider('minimax');
    expect(svc.resolveProvider('auto').name).toBe('minimax');
  });
});
