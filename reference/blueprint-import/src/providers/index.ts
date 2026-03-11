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

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface ChatResponse {
  content: string;
  model: string;
  provider: string;
  tokens?: { prompt: number; completion: number; total: number };
}

export interface ChatOptions {
  model?: string;
  temperature?: number;
  maxTokens?: number;
  systemPrompt?: string;
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
    const body = {
      model,
      messages: opts?.systemPrompt
        ? [{ role: 'system', content: opts.systemPrompt }, ...messages]
        : messages,
      stream: false,
      options: {
        temperature: opts?.temperature ?? 0.7,
        num_predict: opts?.maxTokens ?? 2048,
      },
    };

    const r = await fetch(`${this.baseUrl}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });

    if (!r.ok) throw new Error(`Ollama error: ${r.status} ${await r.text()}`);

    const data = (await r.json()) as {
      message?: { content: string };
      eval_count?: number;
      prompt_eval_count?: number;
    };

    return {
      content: data.message?.content || '',
      model,
      provider: 'ollama',
      tokens: {
        prompt: data.prompt_eval_count || 0,
        completion: data.eval_count || 0,
        total: (data.prompt_eval_count || 0) + (data.eval_count || 0),
      },
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
    const r = await fetch(`${this.baseUrl}/text/chatcompletion_v2`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify({
        model,
        messages: opts?.systemPrompt
          ? [{ role: 'system', content: opts.systemPrompt }, ...messages]
          : messages,
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
    const allMessages = opts?.systemPrompt
      ? [{ role: 'system' as const, content: opts.systemPrompt }, ...messages]
      : messages;

    const r = await fetch(`${this.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${this.apiKey}`,
        ...this.extraHeaders,
      },
      body: JSON.stringify({
        model,
        messages: allMessages,
        temperature: opts?.temperature ?? 0.7,
        max_tokens: opts?.maxTokens ?? 2048,
      }),
    });

    if (!r.ok) throw new Error(`${this.name} error: ${r.status} ${await r.text()}`);
    const data = (await r.json()) as {
      choices?: Array<{ message: { content: string } }>;
      usage?: { prompt_tokens: number; completion_tokens: number; total_tokens: number };
    };

    return {
      content: data.choices?.[0]?.message?.content || '',
      model,
      provider: this.name,
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
// FACTORY — resolves provider by priority
// ═══════════════════════════════════════════

export interface ProviderConfig {
  providers: Array<{
    name: string;
    type: 'ollama' | 'minimax' | 'openai-compatible';
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
 * Default config (Ollama primary, Minimax fallback)
 */
export function defaultProviderConfig(): ProviderConfig {
  return {
    providers: [
      { name: 'ollama', type: 'ollama', priority: 1, model: 'qwen2.5-coder:3b' },
      { name: 'minimax', type: 'minimax', priority: 2, apiKey: process.env.MINIMAX_API_KEY },
    ],
  };
}
