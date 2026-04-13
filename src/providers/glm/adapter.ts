import { randomUUID } from 'node:crypto';

import type { LLMProvider } from '../../core/contracts/llm-provider.js';
import type { GenerateInput, GenerateResult, ProviderHealth } from '../../core/types.js';
import { sanitizeForJsonRequest } from '../../infra/security/sanitizers.js';
import type { ChatMessage, ChatResponse, ChatToolCall, ChatToolDefinition } from '../index.js';

export class GlmProvider {
  name = 'glm';
  private apiKey: string;
  private model: string;
  private baseUrl: string;

  constructor(opts?: { apiKey?: string; model?: string; baseUrl?: string }) {
    this.apiKey = opts?.apiKey || process.env.GLM_API_KEY || '';
    this.model = opts?.model || process.env.GLM_MODEL || 'glm-4-flash';
    this.baseUrl = (
      opts?.baseUrl ||
      process.env.GLM_BASE_URL ||
      'https://open.bigmodel.cn/api/paas/v4'
    ).replace(/\/$/, '');
  }

  isConfigured() {
    return !!this.apiKey;
  }

  async isAvailable(): Promise<boolean> {
    return this.isConfigured();
  }

  async listModels(): Promise<string[]> {
    return ['glm-4.6', 'glm-4.5-air', 'glm-4-flash', 'glm-4', 'glm-4-plus', 'glm-3-turbo'];
  }

  defaultModel() {
    return this.model;
  }

  async chat(messages: ChatMessage[], opts?: {
    model?: string;
    temperature?: number;
    maxTokens?: number;
    systemPrompt?: string;
    tools?: ChatToolDefinition[];
  }): Promise<ChatResponse> {
    const model = opts?.model || this.model;

    const glmMessages = messages.map((m) => {
      if (m.role === 'tool') {
        return { role: 'tool' as const, tool_call_id: m.tool_call_id, content: sanitizeForJsonRequest(m.content) };
      }
      if (m.role === 'assistant' && m.tool_calls?.length) {
        return {
          role: 'assistant' as const,
          content: m.content ? sanitizeForJsonRequest(m.content) : null,
          tool_calls: m.tool_calls.map((tc) => ({
            id: tc.id,
            type: 'function' as const,
            function: { name: tc.name, arguments: JSON.stringify(tc.arguments) },
          })),
        };
      }
      return { role: m.role, content: sanitizeForJsonRequest(m.content) };
    });

    const allMessages = opts?.systemPrompt
      ? [{ role: 'system' as const, content: sanitizeForJsonRequest(opts.systemPrompt) }, ...glmMessages]
      : glmMessages;

    const glmTools = opts?.tools?.map((t) => ({
      type: 'function' as const,
      function: {
        name: t.name,
        description: t.description,
        parameters: t.inputSchema,
      },
    }));

    const body: Record<string, unknown> = {
      model,
      messages: allMessages,
      temperature: opts?.temperature ?? 0.7,
      max_tokens: opts?.maxTokens ?? 2048,
    };

    if (glmTools?.length) {
      body.tools = glmTools;
    }

    const r = await fetch(`${this.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify(body),
    });

    if (!r.ok) throw new Error(`GLM error: ${r.status} ${await r.text()}`);
    const data = (await r.json()) as {
      choices?: Array<{
        message: {
          content: string | null;
          tool_calls?: Array<{
            id: string;
            type: string;
            function: { name: string; arguments: string };
          }>;
        };
      }>;
      usage?: { prompt_tokens: number; completion_tokens: number; total_tokens: number };
    };

    const msg = data.choices?.[0]?.message;
    const toolCalls: ChatToolCall[] | undefined = msg?.tool_calls?.map((tc) => {
      let args: Record<string, unknown> = {};
      if (typeof tc.function.arguments === 'string') {
        try { args = JSON.parse(tc.function.arguments); } catch { args = {}; }
      } else if (tc.function.arguments && typeof tc.function.arguments === 'object') {
        args = tc.function.arguments as Record<string, unknown>;
      }
      return { id: tc.id, name: tc.function.name, arguments: args };
    });

    return {
      content: msg?.content || '',
      model,
      provider: 'glm',
      tokens: data.usage
        ? {
            prompt: data.usage.prompt_tokens,
            completion: data.usage.completion_tokens,
            total: data.usage.total_tokens,
          }
        : undefined,
      tool_calls: toolCalls?.length ? toolCalls : undefined,
    };
  }
}

/**
 * LLMProvider wrapper for GlmProvider.
 * Implements the generate()-based LLMProvider interface by delegating to GlmProvider.chat().
 */
export class GlmLlmProvider implements LLMProvider {
  public readonly name = 'glm' as const;
  private readonly inner: GlmProvider;

  constructor(opts?: { apiKey?: string; model?: string; baseUrl?: string }) {
    this.inner = new GlmProvider(opts);
  }

  public async healthCheck(): Promise<ProviderHealth> {
    const ok = await this.inner.isAvailable();
    return {
      name: this.name,
      ok,
      latencyMs: ok ? 1 : 0,
    };
  }

  public async generate(input: GenerateInput): Promise<GenerateResult> {
    const started = Date.now();
    const messages = input.messages ?? [{ role: 'user' as const, content: input.input ?? '' }];
    const response = await this.inner.chat(messages, {
      model: input.model,
      temperature: input.options?.temperature,
      maxTokens: input.options?.maxTokens,
      systemPrompt: input.systemPrompt,
      tools: input.tools,
    });

    return {
      id: `gen_${randomUUID()}`,
      providerUsed: this.name,
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
  }
}
