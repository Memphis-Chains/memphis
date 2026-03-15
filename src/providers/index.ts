/**
 * Memphis LLM Provider System
 *
 * Priority chain: explicit → config → env → Ollama fallback
 *
 * All providers implement the same interface.
 * Adding a new provider = one file + register in factory.
 */

// ═══════════════════════════════════════════
// INTERFACE
// ═══════════════════════════════════════════

export interface ChatToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export interface ChatToolCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}

export type ChatMessage =
  | { role: 'system'; content: string }
  | { role: 'user'; content: string }
  | { role: 'assistant'; content: string; tool_calls?: ChatToolCall[] }
  | { role: 'tool'; tool_call_id: string; content: string };

export interface ChatResponse {
  content: string;
  model: string;
  provider: string;
  tokens?: { prompt: number; completion: number; total: number };
  tool_calls?: ChatToolCall[];
}

export interface ChatOptions {
  model?: string;
  temperature?: number;
  maxTokens?: number;
  systemPrompt?: string;
  tools?: ChatToolDefinition[];
}

export interface Provider {
  name: string;
  isConfigured(): boolean;
  isAvailable(): Promise<boolean>;
  listModels(): Promise<string[]>;
  defaultModel(): string;
  chat(messages: ChatMessage[], opts?: ChatOptions): Promise<ChatResponse>;
}

// ═══════════════════════════════════════════
// OLLAMA (always available, local-first)
// ═══════════════════════════════════════════

export class OllamaProvider implements Provider {
  name = 'ollama';
  private baseUrl: string;
  private model: string;

  constructor(opts?: { url?: string; model?: string }) {
    this.baseUrl = opts?.url || process.env.OLLAMA_URL || 'http://127.0.0.1:11434';
    this.model = opts?.model || process.env.OLLAMA_MODEL || 'qwen2.5-coder:3b';
  }

  isConfigured() {
    return true;
  }

  async isAvailable(): Promise<boolean> {
    try {
      const r = await fetch(`${this.baseUrl}/api/tags`, { signal: AbortSignal.timeout(3000) });
      return r.ok;
    } catch {
      return false;
    }
  }

  async listModels(): Promise<string[]> {
    try {
      const r = await fetch(`${this.baseUrl}/api/tags`);
      const d = (await r.json()) as { models?: Array<{ name: string }> };
      return d.models?.map((m) => m.name) || [];
    } catch {
      return [];
    }
  }

  defaultModel() {
    return this.model;
  }

  async chat(messages: ChatMessage[], opts?: ChatOptions): Promise<ChatResponse> {
    const model = opts?.model || this.model;

    // Convert ChatMessage union to Ollama's message format
    const ollamaMessages = messages.map((m) => {
      if (m.role === 'tool') {
        return { role: 'tool' as const, content: m.content };
      }
      return { role: m.role, content: m.content };
    });

    const allMessages = opts?.systemPrompt
      ? [{ role: 'system' as const, content: opts.systemPrompt }, ...ollamaMessages]
      : ollamaMessages;

    // Build Ollama tools format from ChatToolDefinition
    const ollamaTools = opts?.tools?.map((t) => ({
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
      stream: false,
      options: {
        temperature: opts?.temperature ?? 0.7,
        num_predict: opts?.maxTokens ?? 2048,
      },
    };

    if (ollamaTools?.length) {
      body.tools = ollamaTools;
    }

    const r = await fetch(`${this.baseUrl}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });

    if (!r.ok) throw new Error(`Ollama error: ${r.status} ${await r.text()}`);

    const data = (await r.json()) as {
      message?: {
        content: string;
        tool_calls?: Array<{
          function: { name: string; arguments: Record<string, unknown> };
        }>;
      };
      eval_count?: number;
      prompt_eval_count?: number;
    };

    // Extract tool calls from Ollama response
    const toolCalls: ChatToolCall[] | undefined = data.message?.tool_calls?.map((tc, i) => ({
      id: `call_${Date.now()}_${i}`,
      name: tc.function.name,
      arguments: typeof tc.function.arguments === 'string'
        ? JSON.parse(tc.function.arguments)
        : tc.function.arguments,
    }));

    return {
      content: data.message?.content || '',
      model,
      provider: 'ollama',
      tokens: {
        prompt: data.prompt_eval_count || 0,
        completion: data.eval_count || 0,
        total: (data.prompt_eval_count || 0) + (data.eval_count || 0),
      },
      tool_calls: toolCalls?.length ? toolCalls : undefined,
    };
  }
}

// ═══════════════════════════════════════════
// MINIMAX
// ═══════════════════════════════════════════

export class MinimaxProvider implements Provider {
  name = 'minimax';
  private apiKey: string;
  private model: string;
  private baseUrl = 'https://api.minimaxi.chat/v1';

  constructor(opts?: { apiKey?: string; model?: string }) {
    this.apiKey = opts?.apiKey || process.env.MINIMAX_API_KEY || '';
    this.model = opts?.model || 'abab5.5-chat';
  }

  isConfigured() {
    return !!this.apiKey;
  }

  async isAvailable(): Promise<boolean> {
    return this.isConfigured();
  }

  async listModels(): Promise<string[]> {
    return ['abab5.5-chat', 'abab6-chat', 'abab6.5s-chat'];
  }

  defaultModel() {
    return this.model;
  }

  async chat(messages: ChatMessage[], opts?: ChatOptions): Promise<ChatResponse> {
    const model = opts?.model || this.model;

    // Convert ChatMessage union to simple role/content for MiniMax
    const mmMessages = messages.map((m) => {
      if (m.role === 'tool') {
        return { role: 'tool' as const, content: m.content };
      }
      return { role: m.role, content: m.content };
    });

    const allMessages = opts?.systemPrompt
      ? [{ role: 'system' as const, content: opts.systemPrompt }, ...mmMessages]
      : mmMessages;

    const r = await fetch(`${this.baseUrl}/text/chatcompletion_v2`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify({
        model,
        messages: allMessages,
        temperature: opts?.temperature ?? 0.7,
        max_tokens: opts?.maxTokens ?? 2048,
      }),
    });

    if (!r.ok) throw new Error(`Minimax error: ${r.status} ${await r.text()}`);
    const data = (await r.json()) as {
      choices?: Array<{ message: { content: string } }>;
      usage?: { prompt_tokens: number; completion_tokens: number; total_tokens: number };
    };

    return {
      content: data.choices?.[0]?.message?.content || '',
      model,
      provider: 'minimax',
      tokens: data.usage
        ? {
            prompt: data.usage.prompt_tokens,
            completion: data.usage.completion_tokens,
            total: data.usage.total_tokens,
          }
        : undefined,
    };
  }
}

// ═══════════════════════════════════════════
// OPENAI-COMPATIBLE (works for OpenAI, OpenRouter, DeepSeek, any /v1/chat/completions)
// ═══════════════════════════════════════════

export class OpenAICompatibleProvider implements Provider {
  name: string;
  private baseUrl: string;
  private apiKey: string;
  private model: string;
  private extraHeaders: Record<string, string>;

  constructor(opts: {
    name: string;
    baseUrl: string;
    apiKey: string;
    model: string;
    extraHeaders?: Record<string, string>;
  }) {
    this.name = opts.name;
    this.baseUrl = opts.baseUrl;
    this.apiKey = opts.apiKey;
    this.model = opts.model;
    this.extraHeaders = opts.extraHeaders || {};
  }

  isConfigured() {
    return !!this.apiKey;
  }
  async isAvailable() {
    return this.isConfigured();
  }
  async listModels() {
    return [this.model];
  }
  defaultModel() {
    return this.model;
  }

  async chat(messages: ChatMessage[], opts?: ChatOptions): Promise<ChatResponse> {
    const model = opts?.model || this.model;

    // Convert ChatMessage union to OpenAI message format
    const oaiMessages = messages.map((m) => {
      if (m.role === 'tool') {
        return { role: 'tool' as const, tool_call_id: m.tool_call_id, content: m.content };
      }
      if (m.role === 'assistant' && m.tool_calls?.length) {
        return {
          role: 'assistant' as const,
          content: m.content,
          tool_calls: m.tool_calls.map((tc) => ({
            id: tc.id,
            type: 'function' as const,
            function: { name: tc.name, arguments: JSON.stringify(tc.arguments) },
          })),
        };
      }
      return { role: m.role, content: m.content };
    });

    const allMessages = opts?.systemPrompt
      ? [{ role: 'system' as const, content: opts.systemPrompt }, ...oaiMessages]
      : oaiMessages;

    const oaiTools = opts?.tools?.map((t) => ({
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

    if (oaiTools?.length) {
      body.tools = oaiTools;
    }

    const r = await fetch(`${this.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${this.apiKey}`,
        ...this.extraHeaders,
      },
      body: JSON.stringify(body),
    });

    if (!r.ok) throw new Error(`${this.name} error: ${r.status} ${await r.text()}`);
    const data = (await r.json()) as {
      choices?: Array<{
        message: {
          content: string;
          tool_calls?: Array<{
            id: string;
            function: { name: string; arguments: string };
          }>;
        };
      }>;
      usage?: { prompt_tokens: number; completion_tokens: number; total_tokens: number };
    };

    const msg = data.choices?.[0]?.message;
    const toolCalls: ChatToolCall[] | undefined = msg?.tool_calls?.map((tc) => ({
      id: tc.id,
      name: tc.function.name,
      arguments: JSON.parse(tc.function.arguments),
    }));

    return {
      content: msg?.content || '',
      model,
      provider: this.name,
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

// ═══════════════════════════════════════════
// FACTORY — resolves provider by priority
// ═══════════════════════════════════════════

export interface ProviderConfig {
  providers: Array<{
    name: string;
    type: 'ollama' | 'minimax' | 'deepseek' | 'openai-compatible';
    priority: number;
    url?: string;
    apiKey?: string;
    model?: string;
    extraHeaders?: Record<string, string>;
  }>;
}

export function createProvider(cfg: ProviderConfig['providers'][0]): Provider {
  switch (cfg.type) {
    case 'ollama':
      return new OllamaProvider({ url: cfg.url, model: cfg.model });
    case 'minimax':
      return new MinimaxProvider({ apiKey: cfg.apiKey, model: cfg.model });
    case 'deepseek':
      return new OpenAICompatibleProvider({
        name: 'deepseek',
        baseUrl: cfg.url || 'https://api.deepseek.com',
        apiKey: cfg.apiKey || process.env.DEEPSEEK_API_KEY || '',
        model: cfg.model || 'deepseek-chat',
      });
    case 'openai-compatible':
      return new OpenAICompatibleProvider({
        name: cfg.name,
        baseUrl: cfg.url || 'https://api.openai.com/v1',
        apiKey: cfg.apiKey || '',
        model: cfg.model || 'gpt-4o',
        extraHeaders: cfg.extraHeaders,
      });
    default:
      throw new Error(`Unknown provider type: ${cfg.type}`);
  }
}

/**
 * Resolve best available provider from config
 */
export async function resolveProvider(config: ProviderConfig): Promise<Provider> {
  const sorted = [...config.providers].sort((a, b) => a.priority - b.priority);

  for (const cfg of sorted) {
    try {
      const provider = createProvider(cfg);
      if (provider.isConfigured() && (await provider.isAvailable())) {
        return provider;
      }
    } catch {
      continue;
    }
  }

  // Ultimate fallback: Ollama with defaults
  return new OllamaProvider();
}

/**
 * Default config (Ollama primary, DeepSeek/Minimax fallback)
 */
export function defaultProviderConfig(): ProviderConfig {
  const providers: ProviderConfig['providers'] = [
    { name: 'ollama', type: 'ollama', priority: 1, model: 'qwen2.5-coder:3b' },
  ];

  if (process.env.DEEPSEEK_API_KEY) {
    providers.push({
      name: 'deepseek', type: 'deepseek', priority: 2,
      apiKey: process.env.DEEPSEEK_API_KEY,
      model: process.env.DEEPSEEK_MODEL || 'deepseek-chat',
    });
  }

  if (process.env.MINIMAX_API_KEY) {
    providers.push({
      name: 'minimax', type: 'minimax', priority: 3,
      apiKey: process.env.MINIMAX_API_KEY,
    });
  }

  return { providers };
}
