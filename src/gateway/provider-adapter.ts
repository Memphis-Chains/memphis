/**
 * Wraps a Memphis Provider (chat interface) into the LlmClient
 * interface that the gateway loop expects.
 */

import type { LlmClient, LlmResponse } from './chat-types.js';
import type { ChatMessage, ChatToolDefinition, ChatOptions } from '../providers/index.js';
import type { RuntimeProvider } from '../providers/runtime.js';

export function providerToLlmClient(
  provider: Pick<RuntimeProvider, 'chat'>,
  defaults: Pick<ChatOptions, 'model' | 'temperature' | 'maxTokens'> = {},
): LlmClient {
  return {
    async complete(input: {
      system: string;
      messages: ChatMessage[];
      tools?: ChatToolDefinition[];
    }): Promise<LlmResponse> {
      const response = await provider.chat(input.messages, {
        model: defaults.model,
        temperature: defaults.temperature,
        maxTokens: defaults.maxTokens,
        systemPrompt: input.system,
        tools: input.tools,
      });

      return {
        content: response.content,
        tool_calls: response.tool_calls,
        usage: response.tokens
          ? {
              inputTokens: response.tokens.prompt,
              outputTokens: response.tokens.completion,
              totalTokens: response.tokens.total,
              estimated: response.tokens.estimated,
            }
          : undefined,
      };
    },
  };
}
