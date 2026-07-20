import { describe, expect, it } from 'vitest';

import { runCli } from '../helpers/cli.js';

describe('CLI providers/models list', () => {
  it('prints configured providers as JSON', async () => {
    const out = await runCli(['providers', 'list', '--json'], {
      env: {
        LOCAL_FALLBACK_ENABLED: 'true',
        SHARED_LLM_API_BASE: 'https://shared.example.test/v1',
        SHARED_LLM_API_KEY: 'shared-key',
        DECENTRALIZED_LLM_API_BASE: 'https://decentralized.example.test/v1',
        DECENTRALIZED_LLM_API_KEY: 'decentralized-key',
        MINIMAX_API_KEY: 'minimax-key',
        DEEPSEEK_API_KEY: 'deepseek-key',
        GLM_API_KEY: 'glm-key',
      },
    });

    const data = JSON.parse(out) as {
      providers: Array<{ name: string; status: string; type: string }>;
    };
    expect(Array.isArray(data.providers)).toBe(true);
    expect(data.providers.map((item) => item.name)).toEqual(
      expect.arrayContaining([
        'local-fallback',
        'ollama',
        'shared-llm',
        'decentralized-llm',
        'minimax',
        'deepseek',
        'glm',
      ]),
    );
    expect(
      data.providers.every((item) => item.status === 'healthy' || item.status === 'unhealthy'),
    ).toBe(true);
  });

  it('prints models with capabilities as JSON', async () => {
    const out = await runCli(['models', 'list', '--json'], {
      env: {
        LOCAL_FALLBACK_ENABLED: 'true',
        OLLAMA_URL: 'http://127.0.0.1:9',
        OLLAMA_MODEL: 'qwen2.5-coder:3b',
        SHARED_LLM_API_BASE: 'http://127.0.0.1:9',
        SHARED_LLM_API_KEY: 'shared-key',
        SHARED_LLM_MODEL: 'shared-model',
        DECENTRALIZED_LLM_API_BASE: 'http://127.0.0.1:9',
        DECENTRALIZED_LLM_API_KEY: 'decentralized-key',
        DECENTRALIZED_LLM_MODEL: 'decentralized-model',
        MINIMAX_API_KEY: 'minimax-key',
        MINIMAX_BASE_URL: 'http://127.0.0.1:9',
        MINIMAX_MODEL: 'MiniMax-M3',
        DEEPSEEK_API_KEY: 'deepseek-key',
        DEEPSEEK_API_BASE: 'http://127.0.0.1:9',
        DEEPSEEK_MODEL: 'deepseek-chat',
        GLM_API_KEY: 'glm-key',
        GLM_BASE_URL: 'http://127.0.0.1:9',
        GLM_MODEL: 'glm-4-flash',
      },
    });

    const data = JSON.parse(out) as {
      models: Array<{
        provider: string;
        model: string;
        capabilities: {
          supports_streaming: boolean;
          supports_vision: boolean;
          context_window: number;
        };
      }>;
    };

    expect(Array.isArray(data.models)).toBe(true);
    expect(data.models.length).toBeGreaterThan(0);
    expect(data.models.map((model) => model.provider)).toEqual(
      expect.arrayContaining([
        'local-fallback',
        'ollama',
        'shared-llm',
        'decentralized-llm',
        'minimax',
        'deepseek',
        'glm',
      ]),
    );

    for (const model of data.models) {
      expect(typeof model.provider).toBe('string');
      expect(typeof model.model).toBe('string');
      expect(typeof model.capabilities.supports_streaming).toBe('boolean');
      expect(typeof model.capabilities.supports_vision).toBe('boolean');
      expect(typeof model.capabilities.context_window).toBe('number');
    }
    expect(data.models).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          provider: 'minimax',
          model: 'MiniMax-M3',
          capabilities: expect.objectContaining({
            supports_streaming: true,
            supports_vision: true,
            context_window: 1000000,
          }),
        }),
      ]),
    );
  });
});
