/* eslint-disable no-restricted-syntax */
//
// Provider runtime — reads provider-specific MODEL env vars
// (ANTHROPIC_MODEL, OLLAMA_MODEL, MINIMAX_MODEL, etc.) at runtime to
// pick the active model name. Same rationale as src/providers/index.ts:
// adding registry accessors for keys only this file reads bloats the
// registry without consumer benefit. The adapters themselves carry
// strong-typed config from their constructors.
//
import { randomUUID } from 'node:crypto';

import type { ChatMessage, ChatOptions, ChatResponse, Provider } from './index.js';
import type { LLMProvider } from '../core/contracts/llm-provider.js';
import { AppError } from '../core/errors.js';
import type { GenerateInput, GenerateResult, ProviderHealth, ProviderName } from '../core/types.js';

export interface RuntimeProvider {
  readonly name: ProviderName;
  isConfigured(): boolean;
  isAvailable(): Promise<boolean>;
  listModels(): Promise<string[]>;
  defaultModel(): string;
  healthCheck(): Promise<ProviderHealth>;
  chat(messages: ChatMessage[], opts?: ChatOptions): Promise<ChatResponse>;
  generate(input: GenerateInput): Promise<GenerateResult>;
}

type GenerateAdapterOptions = {
  defaultModel?: string;
  listModels?: string[];
  configured?: boolean;
};

function serializeMessage(message: ChatMessage): string {
  switch (message.role) {
    case 'system':
      return `SYSTEM: ${message.content}`;
    case 'user':
      return `USER: ${message.content}`;
    case 'assistant':
      return message.tool_calls?.length
        ? `ASSISTANT: ${message.content}\nTOOL_CALLS: ${JSON.stringify(message.tool_calls)}`
        : `ASSISTANT: ${message.content}`;
    case 'tool':
      return `TOOL(${message.tool_call_id}): ${message.content}`;
  }
}

function serializeConversation(messages: ChatMessage[], opts?: ChatOptions): string {
  const parts: string[] = [];
  if (opts?.systemPrompt) {
    parts.push(`SYSTEM: ${opts.systemPrompt}`);
  }
  if (opts?.tools?.length) {
    parts.push(`TOOLS: ${opts.tools.map((tool) => tool.name).join(', ')}`);
  }
  for (const message of messages) {
    parts.push(serializeMessage(message));
  }
  return parts.join('\n\n');
}

function buildGenerateInputFromChat(messages: ChatMessage[], opts?: ChatOptions): GenerateInput {
  return {
    input: serializeConversation(messages, opts),
    model: opts?.model,
    systemPrompt: opts?.systemPrompt,
    tools: opts?.tools,
    options: {
      temperature: opts?.temperature,
      maxTokens: opts?.maxTokens,
    },
  };
}

function buildChatMessagesFromGenerateInput(input: GenerateInput): ChatMessage[] {
  if (input.messages && input.messages.length > 0) {
    return input.messages as ChatMessage[];
  }
  if (input.input && input.input.trim().length > 0) {
    return [{ role: 'user', content: input.input }];
  }
  throw new AppError('VALIDATION_ERROR', 'input or messages[] is required', 400);
}

function defaultModelForGenerateProvider(name: ProviderName): string {
  switch (name) {
    case 'anthropic':
      return process.env.ANTHROPIC_MODEL ?? 'claude-sonnet-4-6';
    case 'local-fallback':
      return 'local-fallback-v0';
    case 'shared-llm':
      return process.env.SHARED_LLM_MODEL ?? process.env.OPENAI_COMPATIBLE_MODEL ?? 'shared-llm';
    case 'decentralized-llm':
      return process.env.DECENTRALIZED_LLM_MODEL ?? 'decentralized-llm';
    case 'glm':
      return process.env.GLM_MODEL ?? 'glm-4-flash';
    case 'ollama':
      return process.env.OLLAMA_MODEL ?? 'qwen2.5-coder:3b';
    case 'minimax':
      return process.env.MINIMAX_MODEL ?? 'MiniMax-M2.7';
    case 'deepseek':
      return process.env.DEEPSEEK_MODEL ?? 'deepseek-chat';
  }
}

export function isRuntimeProvider(
  provider: RuntimeProvider | LLMProvider,
): provider is RuntimeProvider {
  return (
    typeof (provider as RuntimeProvider).chat === 'function' &&
    typeof (provider as RuntimeProvider).generate === 'function' &&
    typeof (provider as RuntimeProvider).defaultModel === 'function'
  );
}

export function adaptChatProvider(provider: Provider): RuntimeProvider {
  return {
    name: provider.name as ProviderName,
    isConfigured: () => provider.isConfigured(),
    isAvailable: () => provider.isAvailable(),
    listModels: () => provider.listModels(),
    defaultModel: () => provider.defaultModel(),
    async healthCheck(): Promise<ProviderHealth> {
      const started = Date.now();
      try {
        const ok = provider.isConfigured() && (await provider.isAvailable());
        return {
          name: provider.name as ProviderName,
          ok,
          latencyMs: Date.now() - started,
          error: ok ? undefined : 'provider unavailable',
        };
      } catch (error) {
        return {
          name: provider.name as ProviderName,
          ok: false,
          latencyMs: Date.now() - started,
          error: error instanceof Error ? error.message : String(error),
        };
      }
    },
    chat: (messages, opts) => provider.chat(messages, opts),
    async generate(input: GenerateInput): Promise<GenerateResult> {
      const started = Date.now();
      const messages = buildChatMessagesFromGenerateInput(input);
      const response = await provider.chat(messages, {
        model: input.model,
        systemPrompt: input.systemPrompt,
        tools: input.tools,
        temperature: input.options?.temperature,
        maxTokens: input.options?.maxTokens,
      });
      return {
        id: `gen_${randomUUID()}`,
        providerUsed: provider.name as ProviderName,
        modelUsed: response.model,
        output: response.content,
        usage: response.tokens
          ? {
              inputTokens: response.tokens.prompt,
              outputTokens: response.tokens.completion,
              totalTokens: response.tokens.total,
              estimated: response.tokens.estimated,
            }
          : undefined,
        timingMs: Date.now() - started,
      };
    },
  };
}

export function adaptGenerateProvider(
  provider: LLMProvider,
  options: GenerateAdapterOptions = {},
): RuntimeProvider {
  const defaultModel = options.defaultModel ?? defaultModelForGenerateProvider(provider.name);
  const listModels = options.listModels ?? [defaultModel];
  const configured = options.configured ?? true;

  return {
    name: provider.name,
    isConfigured: () => configured,
    async isAvailable(): Promise<boolean> {
      const health = await provider.healthCheck();
      return health.ok;
    },
    async listModels(): Promise<string[]> {
      return listModels;
    },
    defaultModel(): string {
      return defaultModel;
    },
    healthCheck(): Promise<ProviderHealth> {
      return provider.healthCheck();
    },
    async chat(messages: ChatMessage[], opts?: ChatOptions): Promise<ChatResponse> {
      const result = await provider.generate(buildGenerateInputFromChat(messages, opts));
      return {
        content: result.output,
        model: result.modelUsed ?? defaultModel,
        provider: provider.name,
        tokens: result.usage
          ? {
              prompt: result.usage.inputTokens ?? 0,
              completion: result.usage.outputTokens ?? 0,
              total:
                result.usage.totalTokens ??
                (result.usage.inputTokens ?? 0) + (result.usage.outputTokens ?? 0),
              estimated: result.usage.estimated,
            }
          : undefined,
      };
    },
    generate(input: GenerateInput): Promise<GenerateResult> {
      return provider.generate(input);
    },
  };
}

export function normalizeRuntimeProvider(provider: RuntimeProvider | LLMProvider): RuntimeProvider {
  return isRuntimeProvider(provider) ? provider : adaptGenerateProvider(provider);
}
