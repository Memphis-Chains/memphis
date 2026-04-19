import { randomUUID } from 'node:crypto';

import type { LLMProvider } from '../../core/contracts/llm-provider.js';
import { AppError } from '../../core/errors.js';
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

    if (!input.input) {
      throw new AppError('VALIDATION_ERROR', 'input field is required for generate', 400);
    }
    const textInput = input.input;

    const output = `Fallback response: ${textInput}`;

    return {
      id: `gen_${randomUUID()}`,
      providerUsed: this.name,
      modelUsed: 'local-fallback-v0',
      output,
      usage: {
        inputTokens: Math.ceil(textInput.length / 4),
        outputTokens: Math.ceil(output.length / 4),
        totalTokens: Math.ceil(textInput.length / 4) + Math.ceil(output.length / 4),
        estimated: true,
      },
      timingMs: Date.now() - started,
    };
  }
}
