import { describe, expect, it } from 'vitest';

import type { LLMProvider } from '../../src/core/contracts/llm-provider.js';
import { AppError } from '../../src/core/errors.js';
import { OrchestrationService } from '../../src/modules/orchestration/service.js';

class AlwaysFailShared implements LLMProvider {
  readonly name = 'shared-llm' as const;
  async healthCheck() {
    return { name: this.name, ok: false, error: 'down' };
  }
  async generate() {
    throw new AppError('PROVIDER_TIMEOUT', 'timeout', 504);
  }
}

class LocalOk implements LLMProvider {
  readonly name = 'local-fallback' as const;
  async healthCheck() {
    return { name: this.name, ok: true, latencyMs: 1 };
  }
  async generate() {
    return {
      id: 'gen_local',
      providerUsed: this.name,
      modelUsed: 'local',
      output: 'ok',
      timingMs: 1,
    };
  }
}

describe('Provider failover v2', () => {
  it('falls back and keeps serving via local when shared keeps failing', async () => {
    const svc = new OrchestrationService({
      defaultProvider: 'shared-llm',
      fallbackProvider: 'local-fallback',
      maxRetries: 0,
      providerCooldownMs: 10_000,
      providers: [new AlwaysFailShared(), new LocalOk()],
    });

    const r1 = await svc.generate({ input: 'x', provider: 'auto' });
    expect(r1.providerUsed).toBe('local-fallback');

    const r2 = await svc.generate({ input: 'y', provider: 'auto' });
    expect(r2.providerUsed).toBe('local-fallback');
  });
});
