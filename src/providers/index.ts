import { createContextualLogger } from '../infra/logging/contextual.js';
import { sanitizeForJsonRequest } from '../infra/security/sanitizers.js';
import { readVaultSecretByKey } from '../security/vault-boundary.js';
import { AnthropicProvider } from './anthropic/adapter.js';
import { GlmProvider } from './glm/adapter.js';

// Module-scoped logger for silent-catch sites — provider-internal causes
// are surfaced to logs without changing the caller-facing return shape.
// Truth model: catch sites that previously discarded the error now feed
// the cause into the audit trail so operators can diagnose flakes after
// the fact.
const log = createContextualLogger({ component: 'providers/index' });

// Memphis LLM Provider System
//
// Priority chain: explicit → config → vault → Ollama fallback
// All providers implement the same interface.
// Adding a new provider = one file + register in factory.
// Provider API keys are stored in vault (vault-first).

// ═══════════════════════════════════════════
// INTERFACE
// ═══════════════════════════════════════════

export interface ChatToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  isConcurrencySafe?: boolean;
  isReadOnly?: boolean;
  isDestructive?: boolean;
  interruptBehavior?: 'block' | 'cancel';
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
  tokens?: { prompt: number; completion: number; total: number; estimated?: boolean };
  tool_calls?: ChatToolCall[];
}

export interface ChatOptions {
  model?: string;
  temperature?: number;
  maxTokens?: number;
  systemPrompt?: string;
  tools?: ChatToolDefinition[];
  /** Ollama-only tuning (ignored by other providers). */
  topP?: number;
  topK?: number;
  repeatPenalty?: number;
  numCtx?: number;
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

function readOllamaEnvNumber(rawEnv: NodeJS.ProcessEnv, key: string): number | undefined {
  const value = rawEnv[key];
  if (value === undefined || value === '') return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

/**
 * Resolve Ollama generation options with this precedence:
 *   1. explicit ChatOptions from caller
 *   2. OLLAMA_* env tuning knobs
 *   3. offline-friendly defaults (low temp, bounded but generous context)
 *
 * Exported for tests.
 */
export function resolveOllamaOptions(
  opts: ChatOptions | undefined,
  rawEnv: NodeJS.ProcessEnv = process.env,
): {
  temperature: number;
  num_predict: number;
  top_p?: number;
  top_k?: number;
  repeat_penalty?: number;
  num_ctx?: number;
} {
  const envTemp = readOllamaEnvNumber(rawEnv, 'OLLAMA_TEMPERATURE');
  const envTopP = readOllamaEnvNumber(rawEnv, 'OLLAMA_TOP_P');
  const envTopK = readOllamaEnvNumber(rawEnv, 'OLLAMA_TOP_K');
  const envRepeatPenalty = readOllamaEnvNumber(rawEnv, 'OLLAMA_REPEAT_PENALTY');
  const envNumCtx = readOllamaEnvNumber(rawEnv, 'OLLAMA_NUM_CTX');
  const envNumPredict = readOllamaEnvNumber(rawEnv, 'OLLAMA_NUM_PREDICT_OFFLINE');

  return {
    temperature: opts?.temperature ?? envTemp ?? 0.2,
    num_predict: opts?.maxTokens ?? envNumPredict ?? 4096,
    top_p: opts?.topP ?? envTopP ?? 0.85,
    top_k: opts?.topK ?? envTopK,
    repeat_penalty: opts?.repeatPenalty ?? envRepeatPenalty ?? 1.15,
    num_ctx: opts?.numCtx ?? envNumCtx ?? 8192,
  };
}

export class OllamaProvider implements Provider {
  name = 'ollama';
  private baseUrl: string;
  private model: string;
  private rawEnv: NodeJS.ProcessEnv;

  constructor(opts?: { url?: string; model?: string; rawEnv?: NodeJS.ProcessEnv }) {
    this.rawEnv = opts?.rawEnv ?? process.env;
    this.baseUrl = opts?.url || this.rawEnv.OLLAMA_URL || 'http://127.0.0.1:11434';
    this.model = opts?.model || this.rawEnv.OLLAMA_MODEL || 'qwen2.5-coder:3b';
  }

  isConfigured() {
    return true;
  }

  async isAvailable(): Promise<boolean> {
    try {
      const r = await fetch(`${this.baseUrl}/api/tags`, { signal: AbortSignal.timeout(3000) });
      return r.ok;
    } catch {
      // Intentional silent catch — health probe is best-effort and runs
      // on every provider-resolution call. Logging here would spam the
      // operator's logs every time Ollama is offline (the common case).
      return false;
    }
  }

  async listModels(): Promise<string[]> {
    try {
      const r = await fetch(`${this.baseUrl}/api/tags`);
      const d = (await r.json()) as { models?: Array<{ name: string }> };
      return d.models?.map((m) => m.name) || [];
    } catch (e) {
      const cause = e instanceof Error ? e : new Error(String(e));
      log.warn(
        { provider: 'ollama', baseUrl: this.baseUrl, cause: cause.message },
        'ollama listModels failed; returning empty list',
      );
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
        return { role: 'tool' as const, content: sanitizeForJsonRequest(m.content) };
      }
      return { role: m.role, content: sanitizeForJsonRequest(m.content) };
    });

    const allMessages = opts?.systemPrompt
      ? [
          { role: 'system' as const, content: sanitizeForJsonRequest(opts.systemPrompt) },
          ...ollamaMessages,
        ]
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

    const ollamaOptions = resolveOllamaOptions(opts, this.rawEnv);
    // Drop undefineds so we don't send noise keys to Ollama.
    const optionsBody: Record<string, number> = {};
    for (const [k, v] of Object.entries(ollamaOptions)) {
      if (v !== undefined) optionsBody[k] = v;
    }

    const body: Record<string, unknown> = {
      model,
      messages: allMessages,
      stream: false,
      options: optionsBody,
    };

    if (ollamaTools?.length) {
      body.tools = ollamaTools;
    }

    const timeoutMs = readOllamaEnvNumber(this.rawEnv, 'OLLAMA_REQUEST_TIMEOUT_MS') ?? 300_000;
    const r = await fetch(`${this.baseUrl}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
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
    const toolCalls: ChatToolCall[] | undefined = data.message?.tool_calls?.map((tc, i) => {
      let args: Record<string, unknown> = {};
      if (typeof tc.function.arguments === 'string') {
        try {
          args = JSON.parse(tc.function.arguments);
        } catch (e) {
          // Ollama returned non-JSON tool args. The caller can't recover
          // (we set args = {} so the tool gets called with no params),
          // but log the cause so it's visible if a model starts producing
          // malformed tool calls in production.
          const cause = e instanceof Error ? e : new Error(String(e));
          log.warn(
            {
              provider: 'ollama',
              tool: tc.function.name,
              cause: cause.message,
              rawArgs: tc.function.arguments,
            },
            'ollama tool_call arguments did not parse as JSON; falling back to empty args',
          );
          args = {};
        }
      } else if (tc.function.arguments && typeof tc.function.arguments === 'object') {
        args = tc.function.arguments as Record<string, unknown>;
      }
      return { id: `call_${Date.now()}_${i}`, name: tc.function.name, arguments: args };
    });

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
  private baseUrl: string;

  constructor(opts?: { apiKey?: string; model?: string; baseUrl?: string }) {
    this.apiKey = opts?.apiKey || process.env.MINIMAX_API_KEY || '';
    this.model = opts?.model || process.env.MINIMAX_MODEL || 'MiniMax-M2.7';
    this.baseUrl = (
      opts?.baseUrl ||
      process.env.MINIMAX_BASE_URL ||
      'https://api.minimax.io/v1'
    ).replace(/\/$/, '');
  }

  isConfigured() {
    return !!this.apiKey;
  }

  async isAvailable(): Promise<boolean> {
    return this.isConfigured();
  }

  async listModels(): Promise<string[]> {
    return [
      'MiniMax-M2.7',
      'MiniMax-M1',
      'MiniMax-Text-01',
      'abab6.5s-chat',
      'abab6.5-chat',
      'abab5.5-chat',
    ];
  }

  defaultModel() {
    return this.model;
  }

  async chat(messages: ChatMessage[], opts?: ChatOptions): Promise<ChatResponse> {
    const model = opts?.model || this.model;

    // Convert ChatMessage union to MiniMax format with tool calling support
    const mmMessages = messages.map((m) => {
      if (m.role === 'tool') {
        return {
          role: 'tool' as const,
          tool_call_id: m.tool_call_id,
          content: sanitizeForJsonRequest(m.content),
        };
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
      ? [
          { role: 'system' as const, content: sanitizeForJsonRequest(opts.systemPrompt) },
          ...mmMessages,
        ]
      : mmMessages;

    const mmTools = opts?.tools?.map((t) => ({
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

    if (mmTools?.length) {
      body.tools = mmTools;
    }

    // M2.7+ models use OpenAI-compatible endpoint; legacy abab models use v2
    const endpoint = model.startsWith('MiniMax-')
      ? `${this.baseUrl}/chat/completions`
      : `${this.baseUrl}/text/chatcompletion_v2`;

    const r = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify(body),
    });

    if (!r.ok) throw new Error(`Minimax error: ${r.status} ${await r.text()}`);
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
        try {
          args = JSON.parse(tc.function.arguments);
        } catch (e) {
          const cause = e instanceof Error ? e : new Error(String(e));
          log.warn(
            {
              provider: 'minimax',
              tool: tc.function.name,
              cause: cause.message,
              rawArgs: tc.function.arguments,
            },
            'minimax tool_call arguments did not parse as JSON; falling back to empty args',
          );
          args = {};
        }
      } else if (tc.function.arguments && typeof tc.function.arguments === 'object') {
        args = tc.function.arguments as Record<string, unknown>;
      }
      return { id: tc.id, name: tc.function.name, arguments: args };
    });

    return {
      content: msg?.content || '',
      model,
      provider: 'minimax',
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
        return {
          role: 'tool' as const,
          tool_call_id: m.tool_call_id,
          content: sanitizeForJsonRequest(m.content),
        };
      }
      if (m.role === 'assistant' && m.tool_calls?.length) {
        return {
          role: 'assistant' as const,
          content: sanitizeForJsonRequest(m.content),
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
      ? [
          { role: 'system' as const, content: sanitizeForJsonRequest(opts.systemPrompt) },
          ...oaiMessages,
        ]
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
    const toolCalls: ChatToolCall[] | undefined = msg?.tool_calls?.map((tc) => {
      let args: Record<string, unknown> = {};
      if (typeof tc.function.arguments === 'string') {
        try {
          args = JSON.parse(tc.function.arguments);
        } catch (e) {
          const cause = e instanceof Error ? e : new Error(String(e));
          log.warn(
            {
              provider: this.name,
              tool: tc.function.name,
              cause: cause.message,
              rawArgs: tc.function.arguments,
            },
            'tool_call arguments did not parse as JSON; falling back to empty args',
          );
          args = {};
        }
      } else if (tc.function.arguments && typeof tc.function.arguments === 'object') {
        args = tc.function.arguments as Record<string, unknown>;
      }
      return { id: tc.id, name: tc.function.name, arguments: args };
    });

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
// VAULT RESOLUTION — provider API keys
// ═══════════════════════════════════════════

/**
 * Maps provider name to its vault reference env var and vault key name.
 * Vault-first: .env holds MINIMAX_VAULT_KEY=minimax_api_key, not the actual API key.
 */
const VAULT_KEY_MAP: Record<string, { vaultRef: string; vaultKey: string }> = {
  anthropic: { vaultRef: 'ANTHROPIC_VAULT_KEY', vaultKey: 'anthropic_api_key' },
  anthropic_oauth_secret: {
    vaultRef: 'ANTHROPIC_OAUTH_SECRET_VAULT_KEY',
    vaultKey: 'anthropic_oauth_client_secret',
  },
  minimax: { vaultRef: 'MINIMAX_VAULT_KEY', vaultKey: 'minimax_api_key' },
  deepseek: { vaultRef: 'DEEPSEEK_VAULT_KEY', vaultKey: 'deepseek_api_key' },
  glm: { vaultRef: 'GLM_VAULT_KEY', vaultKey: 'glm_api_key' },
};

/**
 * Resolves a provider's API key from vault.
 *
 * Checks *VAULT_KEY env var (e.g., MINIMAX_VAULT_KEY). If set, reads the
 * actual key from vault using the referenced key name.
 *
 * Returns undefined if no vault reference is set or vault read fails.
 */
export function resolveProviderVaultKey(
  provider: string,
  rawEnv: NodeJS.ProcessEnv = process.env,
): string | undefined {
  const mapping = VAULT_KEY_MAP[provider];
  if (!mapping) return undefined;

  const vaultRef = rawEnv[mapping.vaultRef];
  if (!vaultRef) return undefined;

  try {
    const result = readVaultSecretByKey(
      mapping.vaultKey,
      { surface: 'system', command: 'resolve-provider-vault-key' },
      rawEnv,
    );

    if (result.found && result.plaintext) {
      return result.plaintext;
    }
    if (result.error) {
      // Vault returned a non-throwing failure (e.g. decryption failed —
      // see vault-boundary truth model). Surface for diagnostics; the
      // caller still gets undefined and falls back to plaintext envs.
      log.warn(
        { vaultKey: mapping.vaultKey, cause: result.error },
        'provider vault key lookup did not return plaintext',
      );
    }
    return undefined;
  } catch (e) {
    const cause = e instanceof Error ? e : new Error(String(e));
    log.warn(
      { vaultKey: mapping.vaultKey, cause: cause.message },
      'provider vault key lookup threw; falling back to plaintext env or undefined',
    );
    return undefined;
  }
}

const PLAINTEXT_KEY_MAP: Record<string, string> = {
  anthropic: 'ANTHROPIC_API_KEY',
  minimax: 'MINIMAX_API_KEY',
  deepseek: 'DEEPSEEK_API_KEY',
  glm: 'GLM_API_KEY',
};

/**
 * Resolves provider API key with vault-first priority.
 *
 * Priority:
 *  1. If *VAULT_KEY env var is set → resolve from vault (e.g., MINIMAX_VAULT_KEY=minimax_api_key → vault)
 *  2. Else if *API_KEY env var is set → use plaintext (e.g., MINIMAX_API_KEY)
 *  3. Otherwise → undefined
 */
export type ProviderKeyResolution =
  | { source: 'vault'; key: string }
  | { source: 'plaintext'; key: string }
  | {
      source: 'none';
      reason:
        | 'vault_not_configured'
        | 'vault_not_found'
        | 'vault_error'
        | 'plaintext_not_configured';
    }
  | { source: 'conflict'; vaultError: string; plaintextKey: string };

/**
 * Resolves provider API key with vault-first priority and conflict detection.
 *
 * Priority:
 *  1. Vault reference (*VAULT_KEY) set + entry found → 'vault'
 *  2. Vault reference set + entry NOT found + plaintext exists → 'conflict' (security issue)
 *  3. Vault reference set + entry NOT found + no plaintext → 'none' (loud skip)
 *  4. No vault reference + plaintext exists → 'plaintext' (fallback)
 *  5. Neither set → 'none'
 */
export function resolveProviderKeyResult(
  provider: string,
  rawEnv: NodeJS.ProcessEnv = process.env,
): ProviderKeyResolution {
  const mapping = VAULT_KEY_MAP[provider];
  if (!mapping) return { source: 'none', reason: 'vault_not_configured' };

  const vaultRef = rawEnv[mapping.vaultRef];

  if (vaultRef) {
    try {
      const result = readVaultSecretByKey(
        mapping.vaultKey,
        { surface: 'system', command: 'resolve-provider-vault-key' },
        rawEnv,
      );
      if (result.found && result.plaintext) {
        return { source: 'vault', key: result.plaintext };
      }
      // Vault ref set but entry missing — check for plaintext conflict
      const plaintextValue = rawEnv[PLAINTEXT_KEY_MAP[provider]];
      if (plaintextValue?.trim()) {
        return {
          source: 'conflict',
          vaultError: `entry '${vaultRef}' not found in vault`,
          plaintextKey: plaintextValue,
        };
      }
      return { source: 'none', reason: 'vault_not_found' };
    } catch (err) {
      // Vault error — check for plaintext conflict
      const plaintextValue = rawEnv[PLAINTEXT_KEY_MAP[provider]];
      if (plaintextValue?.trim()) {
        return { source: 'conflict', vaultError: String(err), plaintextKey: plaintextValue };
      }
      return { source: 'none', reason: 'vault_error' };
    }
  }

  // No vault ref — fallback to plaintext
  const plaintextValue = rawEnv[PLAINTEXT_KEY_MAP[provider]];
  if (plaintextValue?.trim()) {
    return { source: 'plaintext', key: plaintextValue.trim() };
  }

  return { source: 'none', reason: 'plaintext_not_configured' };
}

export function resolveProviderKey(
  provider: string,
  rawEnv: NodeJS.ProcessEnv = process.env,
): string | undefined {
  const result = resolveProviderKeyResult(provider, rawEnv);
  return result.source === 'vault' || result.source === 'plaintext' ? result.key : undefined;
}

// ═══════════════════════════════════════════
// FACTORY — resolves provider by priority
// ═══════════════════════════════════════════

export interface ProviderConfig {
  providers: Array<{
    name: string;
    type: 'ollama' | 'anthropic' | 'minimax' | 'deepseek' | 'glm' | 'openai-compatible';
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
    case 'anthropic':
      return new AnthropicProvider({
        apiKey: cfg.apiKey,
        model: cfg.model,
        baseUrl: cfg.url,
        oauthClientId: process.env.ANTHROPIC_OAUTH_CLIENT_ID,
        oauthClientSecret: process.env.ANTHROPIC_OAUTH_CLIENT_SECRET,
        oauthTokenUrl: process.env.ANTHROPIC_OAUTH_TOKEN_URL,
      });
    case 'minimax':
      return new MinimaxProvider({ apiKey: cfg.apiKey, model: cfg.model });
    case 'deepseek':
      return new OpenAICompatibleProvider({
        name: 'deepseek',
        baseUrl: cfg.url || 'https://api.deepseek.com',
        apiKey: cfg.apiKey || '',
        model: cfg.model || 'deepseek-chat',
      });
    case 'glm':
      return new GlmProvider({ apiKey: cfg.apiKey, model: cfg.model, baseUrl: cfg.url });
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
    } catch (e) {
      const cause = e instanceof Error ? e : new Error(String(e));
      // When NONE of the configured providers can be created/resolved,
      // the operator sees the Ollama fallback at the bottom of this
      // function and wonders "why didn't my MiniMax provider work?".
      // Logging each skip names the per-provider cause.
      log.warn(
        { providerName: cfg.name, providerType: cfg.type, cause: cause.message },
        'provider construction or availability check threw; skipping in fallback chain',
      );
      continue;
    }
  }

  // Ultimate fallback: Ollama with defaults
  return new OllamaProvider();
}

/**
 * Default config (Ollama primary, DeepSeek/Minimax/GLM fallback via vault-first + plaintext fallback)
 *
 * Provider API keys: vault-first via *VAULT_KEY, with plaintext *API_KEY as fallback.
 * Priority: if *VAULT_KEY is set, resolves from vault; otherwise uses *API_KEY directly.
 */
export function defaultProviderConfig(): ProviderConfig {
  const providers: ProviderConfig['providers'] = [
    { name: 'ollama', type: 'ollama', priority: 1, model: 'qwen2.5-coder:3b' },
  ];

  // Anthropic — resolved from vault via ANTHROPIC_VAULT_KEY, fallback to plaintext ANTHROPIC_API_KEY
  const anthropicKey = resolveProviderKey('anthropic');
  if (anthropicKey) {
    providers.push({
      name: 'anthropic',
      type: 'anthropic',
      priority: 2,
      apiKey: anthropicKey,
      model: process.env.ANTHROPIC_MODEL || 'claude-sonnet-4-6',
    });
  }

  // DeepSeek — resolved from vault via DEEPSEEK_VAULT_KEY, fallback to plaintext DEEPSEEK_API_KEY
  const deepseekKey = resolveProviderKey('deepseek');
  if (deepseekKey) {
    providers.push({
      name: 'deepseek',
      type: 'deepseek',
      priority: 3,
      apiKey: deepseekKey,
      model: process.env.DEEPSEEK_MODEL || 'deepseek-chat',
    });
  }

  // MiniMax — resolved from vault via MINIMAX_VAULT_KEY, fallback to plaintext MINIMAX_API_KEY
  const minimaxKey = resolveProviderKey('minimax');
  if (minimaxKey) {
    providers.push({
      name: 'minimax',
      type: 'minimax',
      priority: 4,
      apiKey: minimaxKey,
      model: process.env.MINIMAX_MODEL || 'MiniMax-M2.7',
    });
  }

  // GLM — resolved from vault via GLM_VAULT_KEY, fallback to plaintext GLM_API_KEY
  // Can be disabled by setting GLM_ENABLED=false in .env
  if (process.env.GLM_ENABLED !== 'false') {
    const glmKey = resolveProviderKey('glm');
    if (glmKey) {
      providers.push({
        name: 'glm',
        type: 'glm',
        priority: 5,
        apiKey: glmKey,
        model: process.env.GLM_MODEL || 'glm-4-flash',
      });
    }
  }

  return { providers };
}
