import { randomUUID } from 'node:crypto';

import type { LLMProvider } from '../../core/contracts/llm-provider.js';
import type { GenerateInput, GenerateResult, ProviderHealth } from '../../core/types.js';

export class LocalFallbackProvider implements LLMProvider {
  public readonly name = 'local-fallback' as const;

  public async healthCheck(): Promise<ProviderHealth> {
    return {
      name: this.name,
      ok: true,
      latencyMs: 1,
    };
  }

  public async generate(input: GenerateInput): Promise<GenerateResult> {
    const started = Date.now();
    const output = `Fallback response: ${input.input}`;

    return {
      id: `gen_${randomUUID()}`,
      providerUsed: this.name,
      modelUsed: 'local-fallback-v0',
      output,
      usage: {
        inputTokens: Math.ceil(input.input.length / 4),
        outputTokens: Math.ceil(output.length / 4),
      },
      timingMs: Date.now() - started,
    };
  }
}
