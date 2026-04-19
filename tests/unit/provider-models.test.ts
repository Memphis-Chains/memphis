import { describe, expect, it, vi } from 'vitest';

import type { ProviderName } from '../../src/core/types.js';
import { OrchestrationService } from '../../src/modules/orchestration/service.js';
import { AnthropicProvider } from '../../src/providers/anthropic/adapter.js';
import { GlmProvider } from '../../src/providers/glm/adapter.js';
import { MinimaxProvider } from '../../src/providers/index.js';
import type { RuntimeProvider } from '../../src/providers/runtime.js';
import { adaptChatProvider } from '../../src/providers/runtime.js';

function mock(
  name: ProviderName,
  models: string[],
  opts: { throws?: boolean } = {},
): RuntimeProvider {
  return {
    name,
    isConfigured: () => true,
    isAvailable: async () => true,
    listModels: async () => {
      if (opts.throws) throw new Error('provider unreachable');
      return models;
    },
    defaultModel: () => models[0] ?? `${name}-default`,
    healthCheck: async () => ({ name, ok: true }),
    chat: vi.fn(),
    generate: vi.fn(),
  };
}

describe('per-provider listModels()', () => {
  it('Anthropic exposes the current Claude 4 lineup', async () => {
    const p = new AnthropicProvider({ apiKey: 'test' });
    const models = await p.listModels();
    expect(models).toEqual(
      expect.arrayContaining(['claude-opus-4-6', 'claude-sonnet-4-6', 'claude-haiku-4-5-20251001']),
    );
  });

  it('Minimax exposes M2.7 + M1 + Text-01 + abab legacy series', async () => {
    const p = new MinimaxProvider({ apiKey: 'test' });
    const models = await p.listModels();
    expect(models).toEqual(
      expect.arrayContaining([
        'MiniMax-M2.7',
        'MiniMax-M1',
        'MiniMax-Text-01',
        'abab6.5s-chat',
        'abab6.5-chat',
        'abab5.5-chat',
      ]),
    );
  });

  it('GLM exposes 4.6 + 4.5-air alongside legacy 4-flash', async () => {
    const p = new GlmProvider({ apiKey: 'test' });
    const models = await p.listModels();
    expect(models).toEqual(expect.arrayContaining(['glm-4.6', 'glm-4.5-air', 'glm-4-flash']));
  });
});

describe('OrchestrationService.providersModels()', () => {
  it('aggregates models across configured providers', async () => {
    const anthropic = mock('anthropic', ['claude-opus-4-6', 'claude-sonnet-4-6']);
    const minimax = mock('minimax', ['MiniMax-M2.7', 'MiniMax-M1']);
    const ollama = mock('ollama', ['cogito:3b', 'nomic-embed-text']);
    const fallback = mock('local-fallback', ['local-fallback-v0']);

    const orchestration = new OrchestrationService({
      defaultProvider: 'anthropic',
      providers: [anthropic, minimax, ollama, fallback],
    });

    const all = await orchestration.providersModels();
    expect(all.anthropic).toEqual(['claude-opus-4-6', 'claude-sonnet-4-6']);
    expect(all.minimax).toEqual(['MiniMax-M2.7', 'MiniMax-M1']);
    expect(all.ollama).toEqual(['cogito:3b', 'nomic-embed-text']);
    expect(all['local-fallback']).toEqual(['local-fallback-v0']);
  });

  it('returns empty array for providers that throw (unreachable endpoint)', async () => {
    const anthropic = mock('anthropic', ['claude-sonnet-4-6']);
    const ollama = mock('ollama', [], { throws: true });
    const fallback = mock('local-fallback', ['local-fallback-v0']);

    const orchestration = new OrchestrationService({
      defaultProvider: 'anthropic',
      providers: [anthropic, ollama, fallback],
    });

    const all = await orchestration.providersModels();
    expect(all.anthropic).toEqual(['claude-sonnet-4-6']);
    expect(all.ollama).toEqual([]);
    expect(all['local-fallback']).toEqual(['local-fallback-v0']);
  });

  it('adaptChatProvider preserves the underlying listModels()', async () => {
    const adapted = adaptChatProvider(new AnthropicProvider({ apiKey: 'test' }));
    const models = await adapted.listModels();
    expect(models).toEqual(expect.arrayContaining(['claude-opus-4-6', 'claude-sonnet-4-6']));
  });
});
