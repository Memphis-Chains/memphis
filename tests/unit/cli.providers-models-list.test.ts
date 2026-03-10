import { describe, expect, it } from 'vitest';
import { execSync } from 'node:child_process';

describe('CLI providers/models list', () => {
  it('prints configured providers as JSON', () => {
    const out = execSync(
      'LOCAL_FALLBACK_ENABLED=true OLLAMA_URL=http://127.0.0.1:11434 OPENAI_COMPATIBLE_API_BASE=https://api.openai.com/v1 npx tsx src/infra/cli/index.ts providers list --json',
      { encoding: 'utf8' },
    );

    const data = JSON.parse(out) as { providers: Array<{ name: string; status: string; type: string }> };
    expect(Array.isArray(data.providers)).toBe(true);
    expect(data.providers.map((item) => item.name)).toEqual(
      expect.arrayContaining(['local-fallback', 'ollama', 'openai-compatible']),
    );
    expect(data.providers.every((item) => item.status === 'healthy' || item.status === 'unhealthy')).toBe(true);
  });

  it('prints models with capabilities as JSON', () => {
    const out = execSync(
      'LOCAL_FALLBACK_ENABLED=true OPENAI_COMPATIBLE_API_BASE=https://api.openai.com/v1 OPENAI_COMPATIBLE_MODEL=gpt-4o-mini npx tsx src/infra/cli/index.ts models list --json',
      { encoding: 'utf8' },
    );

    const data = JSON.parse(out) as {
      models: Array<{
        provider: string;
        model: string;
        capabilities: { supports_streaming: boolean; supports_vision: boolean; context_window: number };
      }>;
    };

    expect(Array.isArray(data.models)).toBe(true);
    expect(data.models.length).toBeGreaterThan(0);

    for (const model of data.models) {
      expect(typeof model.provider).toBe('string');
      expect(typeof model.model).toBe('string');
      expect(typeof model.capabilities.supports_streaming).toBe('boolean');
      expect(typeof model.capabilities.supports_vision).toBe('boolean');
      expect(typeof model.capabilities.context_window).toBe('number');
    }
  });
});
