/**
 * Wraps a Memphis Provider (chat interface) into the LlmClient
 * interface that the gateway loop expects.
 */

import type { LlmClient, LlmResponse } from './chat-types.js';
import type { Provider, ChatMessage, ChatToolDefinition } from '../providers/index.js';

export function providerToLlmClient(provider: Provider): LlmClient {
  return {
    async complete(input: {
      system: string;
      messages: ChatMessage[];
      tools?: ChatToolDefinition[];
    }): Promise<LlmResponse> {
      const response = await provider.chat(input.messages, {
        systemPrompt: input.system,
        tools: input.tools,
      });

      return {
        content: response.content,
        tool_calls: response.tool_calls,
      };
    },
  };
}
