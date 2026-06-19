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

    const textInput = latestUserMessage(input) ?? input.input;
    if (!textInput) {
      throw new AppError('VALIDATION_ERROR', 'input field is required for generate', 400);
    }

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

function latestUserMessage(input: GenerateInput): string | undefined {
  const userMessages: string[] = [];
  if (input.messages?.length) {
    for (const message of input.messages) {
      if (message.role === 'user' && message.content.trim().length > 0) {
        userMessages.push(unwrapUserInputFrame(message.content));
      }
    }
  }
  if (userMessages.length < 2 && input.input) {
    userMessages.push(...extractSerializedUserMessages(input.input));
  }
  const latest = userMessages.at(-1);
  if (!latest) return undefined;
  if (/what did i just say\??/i.test(latest)) {
    return userMessages.at(-2) ?? latest;
  }
  return latest;
}

function unwrapUserInputFrame(content: string): string {
  const match = content.match(/<user_input>\s*([\s\S]*?)\s*<\/user_input>/i);
  return (match?.[1] ?? content).trim();
}

function extractSerializedUserMessages(input: string): string[] {
  const matches = [...input.matchAll(/(?:^|\n\n)USER:\s*([\s\S]*?)(?=\n\n(?:SYSTEM|USER|ASSISTANT|TOOL)\b:|$)/g)];
  return matches
    .map((match) => unwrapUserInputFrame(match[1] ?? ''))
    .filter((content) => content.length > 0);
}
