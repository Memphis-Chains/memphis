import { describe, expect, it, vi } from 'vitest';

import { DecentralizedLlmProvider } from '../../src/providers/decentralized-llm/adapter.js';
import { DecentralizedLlmClient } from '../../src/providers/decentralized-llm/client.js';

describe('DecentralizedLlmProvider', () => {
  it('maps client generate response to provider contract', async () => {
    const client = {
      healthCheck: vi.fn().mockResolvedValue({ ok: true, latencyMs: 10 }),
      generate: vi.fn().mockResolvedValue({
        output: 'decentralized hello',
        model: 'd-model-1',
        usage: { inputTokens: 2, outputTokens: 4 },
      }),
    } as unknown as DecentralizedLlmClient;

    const provider = new DecentralizedLlmProvider(client);
    const result = await provider.generate({ input: 'hello' });

    expect(result.providerUsed).toBe('decentralized-llm');
    expect(result.output).toBe('decentralized hello');
    expect(result.modelUsed).toBe('d-model-1');
  });
});
