import { describe, expect, it, vi } from 'vitest';

import { SharedLlmProvider } from '../../src/providers/shared-llm/adapter.js';
import { SharedLlmClient } from '../../src/providers/shared-llm/client.js';

describe('SharedLlmProvider', () => {
  it('maps client generate response to provider contract', async () => {
    const client = {
      healthCheck: vi.fn().mockResolvedValue({ ok: true, latencyMs: 12 }),
      generate: vi.fn().mockResolvedValue({
        output: 'hello world',
        model: 'shared-model-1',
        usage: { inputTokens: 2, outputTokens: 3 },
      }),
    } as unknown as SharedLlmClient;

    const provider = new SharedLlmProvider(client);
    const result = await provider.generate({ input: 'hello' });

    expect(result.providerUsed).toBe('shared-llm');
    expect(result.output).toBe('hello world');
    expect(result.modelUsed).toBe('shared-model-1');
  });
});
