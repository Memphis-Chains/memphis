import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { ProviderName } from '../../src/core/types.js';
import {
  DEFAULT_PROVIDER_CASCADE,
  OrchestrationService,
  parseCascadeOrder,
} from '../../src/modules/orchestration/service.js';
import type { RuntimeProvider } from '../../src/providers/runtime.js';

function mock(name: ProviderName): RuntimeProvider {
  return {
    name,
    isConfigured: () => true,
    isAvailable: async () => true,
    listModels: async () => [`${name}-model-a`, `${name}-model-b`],
    defaultModel: () => `${name}-model-a`,
    healthCheck: async () => ({ name, ok: true }),
    chat: vi.fn(),
    generate: vi.fn(async () => ({
      id: 'x',
      providerUsed: name,
      output: 'ok',
      timingMs: 1,
    })),
  };
}

describe('parseCascadeOrder', () => {
  it('returns the default cascade when the env value is empty', () => {
    expect(parseCascadeOrder(undefined)).toEqual(DEFAULT_PROVIDER_CASCADE);
    expect(parseCascadeOrder('')).toEqual(DEFAULT_PROVIDER_CASCADE);
    expect(parseCascadeOrder('   ')).toEqual(DEFAULT_PROVIDER_CASCADE);
  });

  it('parses a well-formed comma-separated list', () => {
    expect(parseCascadeOrder('anthropic,minimax,ollama,local-fallback')).toEqual([
      'anthropic',
      'minimax',
      'ollama',
      'local-fallback',
    ]);
  });

  it('trims whitespace and dedupes', () => {
    expect(parseCascadeOrder(' anthropic , anthropic , minimax ,ollama, ollama , local-fallback ')).toEqual([
      'anthropic',
      'minimax',
      'ollama',
      'local-fallback',
    ]);
  });

  it('always appends local-fallback if operator omits it (idiot-defensive)', () => {
    expect(parseCascadeOrder('anthropic,minimax')).toEqual([
      'anthropic',
      'minimax',
      'local-fallback',
    ]);
  });

  it('fails loud on unknown provider names', () => {
    expect(() => parseCascadeOrder('anthropic,typo-here,ollama')).toThrowError(
      /MEMPHIS_PROVIDER_CASCADE contains unknown provider 'typo-here'/,
    );
  });
});

describe('OrchestrationService cascade walk', () => {
  let anthropic: RuntimeProvider;
  let minimax: RuntimeProvider;
  let ollama: RuntimeProvider;
  let fallback: RuntimeProvider;

  beforeEach(() => {
    anthropic = mock('anthropic');
    minimax = mock('minimax');
    ollama = mock('ollama');
    fallback = mock('local-fallback');
  });

  function service(cascadeOrder?: ProviderName[]) {
    return new OrchestrationService({
      defaultProvider: 'anthropic',
      providers: [anthropic, minimax, ollama, fallback],
      providerCooldownMs: 5000,
      cascadeOrder,
    });
  }

  it('lands on anthropic when requested=auto and nothing is degraded', () => {
    const result = service().getCascadeResult('auto');
    expect(result.actualProvider).toBe('anthropic');
    expect(result.tier).toBe(1);
    expect(result.degraded).toBe(false);
  });

  it('cascades auto→minimax→ollama→local-fallback when each upstream fails', () => {
    const orchestration = service();
    const policy = (orchestration as unknown as { providerPolicy: { markFailure: (n: string) => void } }).providerPolicy;

    policy.markFailure('anthropic');
    let result = orchestration.getCascadeResult('auto');
    expect(result.actualProvider).toBe('minimax');
    expect(result.tier).toBe(2);
    expect(result.degraded).toBe(true);

    policy.markFailure('minimax');
    result = orchestration.getCascadeResult('auto');
    expect(result.actualProvider).toBe('ollama');
    expect(result.tier).toBe(3);

    policy.markFailure('ollama');
    result = orchestration.getCascadeResult('auto');
    expect(result.actualProvider).toBe('local-fallback');
    expect(result.tier).toBe(4);
  });

  it('respects MEMPHIS_PROVIDER_CASCADE override — deepseek-first cascade', () => {
    const deepseek = mock('deepseek');
    const glm = mock('glm');
    const orchestration = new OrchestrationService({
      defaultProvider: 'deepseek',
      providers: [deepseek, glm, anthropic, minimax, ollama, fallback],
      cascadeOrder: parseCascadeOrder('deepseek,glm,anthropic,ollama,local-fallback'),
    });

    const result = orchestration.getCascadeResult('auto');
    expect(result.actualProvider).toBe('deepseek');
    expect(result.tier).toBe(1);
    expect(orchestration.getCascadeOrder()).toEqual([
      'deepseek',
      'glm',
      'anthropic',
      'ollama',
      'local-fallback',
    ]);
  });

  it('prepends explicit requested provider to the walk (tier 1)', () => {
    const orchestration = service();
    const result = orchestration.getCascadeResult('minimax');
    expect(result.actualProvider).toBe('minimax');
    expect(result.tier).toBe(1);
  });

  it('degrades through cascade when explicit requested is in cooldown', () => {
    const orchestration = service();
    const policy = (orchestration as unknown as { providerPolicy: { markFailure: (n: string) => void } }).providerPolicy;
    policy.markFailure('minimax');

    const result = orchestration.getCascadeResult('minimax');
    // tier 1 = minimax (cooldown → skip)
    // tier 2 = defaultProvider anthropic
    expect(result.actualProvider).toBe('anthropic');
    expect(result.tier).toBe(2);
    expect(result.degraded).toBe(true);
    expect(result.reason).toContain('minimax in cooldown');
  });

  it('does not throw when cascade is exhausted — local-fallback always terminates', () => {
    const orchestration = service();
    const policy = (orchestration as unknown as { providerPolicy: { markFailure: (n: string) => void } }).providerPolicy;
    policy.markFailure('anthropic');
    policy.markFailure('minimax');
    policy.markFailure('ollama');

    const result = orchestration.getCascadeResult('auto');
    expect(result.actualProvider).toBe('local-fallback');
    expect(result.degraded).toBe(true);
  });

  it('exposes the configured cascade via getCascadeOrder()', () => {
    expect(service().getCascadeOrder()).toEqual(DEFAULT_PROVIDER_CASCADE);
  });
});
