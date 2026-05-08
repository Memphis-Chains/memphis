/**
 * Wraps a Memphis Provider (chat interface) into the LlmClient
 * interface that the gateway loop expects.
 *
 * Sprint 0.1 (otel adoption): provider.completion span emitted around
 * each provider.chat() call, with token + tool-call counts as
 * post-attributes. Span name + attribute namespace stable so cron-driven
 * `otel-coverage` task can grep JSONL deterministically.
 */

import type { LlmClient, LlmResponse } from './chat-types.js';
import { instrument } from '../infra/observability/instrument.js';
import type { ChatMessage, ChatToolDefinition, ChatOptions } from '../providers/index.js';
import type { RuntimeProvider } from '../providers/runtime.js';

export interface ProviderAdapterMeta {
  /** Provider label (e.g. "anthropic", "glm", "ollama"). */
  providerLabel?: string;
  /** Fallback model label when defaults.model is unset. */
  modelLabel?: string;
}

export function providerToLlmClient(
  provider: Pick<RuntimeProvider, 'chat'>,
  defaults: Pick<ChatOptions, 'model' | 'temperature' | 'maxTokens'> = {},
  meta: ProviderAdapterMeta = {},
): LlmClient {
  return {
    async complete(input: {
      system: string;
      messages: ChatMessage[];
      tools?: ChatToolDefinition[];
      temperature?: number;
      maxTokens?: number;
    }): Promise<LlmResponse> {
      const providerName = meta.providerLabel ?? 'unknown';
      const modelName = defaults.model ?? meta.modelLabel ?? 'unknown';

      return instrument(
        'provider.completion',
        {
          'provider.name': providerName,
          'provider.model': modelName,
          'provider.tools.count': input.tools?.length ?? 0,
          'provider.messages.count': input.messages.length,
        },
        async () => {
          // Per-call overrides win over construction-time defaults so cognitive
          // mode dispatch can re-tune temperature/maxTokens on each turn.
          const response = await provider.chat(input.messages, {
            model: defaults.model,
            temperature: input.temperature ?? defaults.temperature,
            maxTokens: input.maxTokens ?? defaults.maxTokens,
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
            finishReason: response.finishReason,
          };
        },
        {
          postAttributes: (r) => {
            const result = r as LlmResponse;
            return {
              'provider.tokens.input': result.usage?.inputTokens ?? 0,
              'provider.tokens.output': result.usage?.outputTokens ?? 0,
              'provider.tokens.total': result.usage?.totalTokens ?? 0,
              'provider.tool_calls.count': result.tool_calls?.length ?? 0,
            };
          },
        },
      );
    },
  };
}
