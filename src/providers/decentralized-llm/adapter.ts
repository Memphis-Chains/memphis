import { randomUUID } from 'node:crypto';

import { DecentralizedLlmClient } from './client.js';
import type { LLMProvider } from '../../core/contracts/llm-provider.js';
import type { GenerateInput, GenerateResult, ProviderHealth } from '../../core/types.js';

export class DecentralizedLlmProvider implements LLMProvider {
  public readonly name = 'decentralized-llm' as const;

  constructor(private readonly client: DecentralizedLlmClient) {}

  public async healthCheck(): Promise<ProviderHealth> {
    const result = await this.client.healthCheck();
    return {
      name: this.name,
      ok: result.ok,
      latencyMs: result.latencyMs,
      error: result.error,
    };
  }

  public async generate(input: GenerateInput): Promise<GenerateResult> {
    const started = Date.now();
    const data = await this.client.generate({
      input: input.input,
      model: input.model,
      options: input.options,
    });

    return {
      id: `gen_${randomUUID()}`,
      providerUsed: this.name,
      modelUsed: data.model,
      output: data.output,
      usage: data.usage,
      timingMs: Date.now() - started,
    };
  }
}
