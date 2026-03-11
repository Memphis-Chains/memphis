import { describe, expect, it } from 'vitest';

import type { LLMProvider } from '../../src/core/contracts/llm-provider.js';
import { AppError } from '../../src/core/errors.js';
import { OrchestrationService } from '../../src/modules/orchestration/service.js';

class FailingSharedProvider implements LLMProvider {
  public readonly name = 'shared-llm' as const;

  async healthCheck() {
    return { name: this.name, ok: false, error: 'down' };
  }

  async generate() {
    throw new AppError('PROVIDER_TIMEOUT', 'timeout', 504);
  }
}

class LocalProvider implements LLMProvider {
  public readonly name = 'local-fallback' as const;

  async healthCheck() {
    return { name: this.name, ok: true, latencyMs: 1 };
  }

  async generate() {
    return {
      id: 'gen_local_1',
      providerUsed: this.name,
      modelUsed: 'local',
      output: 'ok from fallback',
      timingMs: 1,
    };
  }
}

describe('OrchestrationService retry/fallback', () => {
  it('falls back to local provider when primary fails', async () => {
    const svc = new OrchestrationService({
      defaultProvider: 'shared-llm',
      fallbackProvider: 'local-fallback',
      maxRetries: 1,
      providers: [new FailingSharedProvider(), new LocalProvider()],
    });

    const result = await svc.generate({ input: 'hello', provider: 'auto' });
    expect(result.providerUsed).toBe('local-fallback');
    expect(result.output).toContain('fallback');
  });
});
