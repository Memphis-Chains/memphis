/**
 * Native Anthropic Messages API provider.
 *
 * Supports two auth modes:
 *   1. OAuth (preferred) — client_id + client_secret → token exchange → Bearer token
 *   2. API key fallback — static x-api-key header
 *
 * OAuth credentials are stored in vault; tokens are cached in memory and
 * refreshed automatically before expiry.
 */

import { sanitizeForJsonRequest } from '../../infra/security/sanitizers.js';
import type {
  ChatMessage,
  ChatOptions,
  ChatResponse,
  ChatToolCall,
  ChatToolDefinition,
  Provider,
} from '../index.js';

const ANTHROPIC_API_VERSION = '2023-06-01';
const DEFAULT_BASE_URL = 'https://api.anthropic.com';
const DEFAULT_OAUTH_TOKEN_URL = 'https://auth.anthropic.com/oauth/token';
const DEFAULT_MODEL = 'claude-sonnet-4-6';
const DEFAULT_MAX_TOKENS = 4096;

/** Refresh token 60 s before actual expiry to avoid mid-request failures. */
const TOKEN_EXPIRY_BUFFER_MS = 60_000;

// ─── OAuth token cache ───────────────────────────────────────────────────

interface OAuthToken {
  accessToken: string;
  expiresAt: number; // epoch ms
}

interface OAuthTokenResponse {
  access_token: string;
  token_type: string;
  expires_in: number; // seconds
  scope?: string;
}

// ─── Anthropic request types ─────────────────────────────────────────────

interface AnthropicMessage {
  role: 'user' | 'assistant';
  content: string | AnthropicContentBlock[];
}

type AnthropicContentBlock =
  | { type: 'text'; text: string }
  | { type: 'tool_use'; id: string; name: string; input: Record<string, unknown> }
  | { type: 'tool_result'; tool_use_id: string; content: string };

interface AnthropicTool {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
}

interface AnthropicRequestBody {
  model: string;
  max_tokens: number;
  messages: AnthropicMessage[];
  system?: string;
  temperature?: number;
  tools?: AnthropicTool[];
}

// ─── Anthropic response types ────────────────────────────────────────────

interface AnthropicResponse {
  id: string;
  type: 'message';
  role: 'assistant';
  content: Array<
    | { type: 'text'; text: string }
    | { type: 'tool_use'; id: string; name: string; input: Record<string, unknown> }
  >;
  model: string;
  stop_reason: 'end_turn' | 'max_tokens' | 'stop_sequence' | 'tool_use';
  usage: { input_tokens: number; output_tokens: number };
}

interface AnthropicErrorResponse {
  type: 'error';
  error: { type: string; message: string };
}

// ─── Provider options ────────────────────────────────────────────────────

export interface AnthropicProviderOptions {
  /** Static API key (x-api-key auth). Ignored when OAuth is configured. */
  apiKey?: string;
  model?: string;
  baseUrl?: string;

  /** OAuth client credentials (preferred over apiKey when both present). */
  oauthClientId?: string;
  oauthClientSecret?: string;
  oauthTokenUrl?: string;
}

// ─── Provider ────────────────────────────────────────────────────────────

export class AnthropicProvider implements Provider {
  name = 'anthropic';
  private readonly apiKey: string;
  private readonly model: string;
  private readonly baseUrl: string;

  // OAuth state
  private readonly oauthClientId: string;
  private readonly oauthClientSecret: string;
  private readonly oauthTokenUrl: string;
  private cachedToken: OAuthToken | null = null;
  private pendingTokenRequest: Promise<OAuthToken> | null = null;

  constructor(opts?: AnthropicProviderOptions) {
    this.apiKey = opts?.apiKey || process.env.ANTHROPIC_API_KEY || '';
    this.model = opts?.model || process.env.ANTHROPIC_MODEL || DEFAULT_MODEL;
    this.baseUrl = (opts?.baseUrl || process.env.ANTHROPIC_BASE_URL || DEFAULT_BASE_URL).replace(
      /\/$/,
      '',
    );

    this.oauthClientId = opts?.oauthClientId || process.env.ANTHROPIC_OAUTH_CLIENT_ID || '';
    this.oauthClientSecret =
      opts?.oauthClientSecret || process.env.ANTHROPIC_OAUTH_CLIENT_SECRET || '';
    this.oauthTokenUrl =
      opts?.oauthTokenUrl || process.env.ANTHROPIC_OAUTH_TOKEN_URL || DEFAULT_OAUTH_TOKEN_URL;
  }

  private get oauthConfigured(): boolean {
    return !!(this.oauthClientId && this.oauthClientSecret);
  }

  isConfigured(): boolean {
    return this.oauthConfigured || !!this.apiKey;
  }

  async isAvailable(): Promise<boolean> {
    return this.isConfigured();
  }

  async listModels(): Promise<string[]> {
    return [
      'claude-opus-4-6',
      'claude-sonnet-4-6',
      'claude-haiku-4-5-20251001',
      'claude-sonnet-4-5-20250514',
    ];
  }

  defaultModel(): string {
    return this.model;
  }

  // ─── OAuth token management ──────────────────────────────────────────

  /**
   * Exchange client credentials for an access token.
   * Coalesces concurrent requests so only one token fetch is in flight.
   */
  private async getOAuthToken(): Promise<OAuthToken> {
    if (this.cachedToken && Date.now() < this.cachedToken.expiresAt - TOKEN_EXPIRY_BUFFER_MS) {
      return this.cachedToken;
    }

    // Coalesce: if a fetch is already in progress, wait for it.
    if (this.pendingTokenRequest) {
      return this.pendingTokenRequest;
    }

    this.pendingTokenRequest = this.fetchOAuthToken();
    try {
      const token = await this.pendingTokenRequest;
      this.cachedToken = token;
      return token;
    } finally {
      this.pendingTokenRequest = null;
    }
  }

  private async fetchOAuthToken(): Promise<OAuthToken> {
    const r = await fetch(this.oauthTokenUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'client_credentials',
        client_id: this.oauthClientId,
        client_secret: this.oauthClientSecret,
      }),
    });

    if (!r.ok) {
      const text = await r.text().catch(() => '');
      throw new Error(`Anthropic OAuth token exchange failed (${r.status}): ${text}`);
    }

    const data = (await r.json()) as OAuthTokenResponse;
    return {
      accessToken: data.access_token,
      expiresAt: Date.now() + data.expires_in * 1000,
    };
  }

  /**
   * Build auth headers for the request.
   * OAuth → Authorization: Bearer <token>
   * API key → x-api-key: <key>
   */
  private async resolveAuthHeaders(): Promise<Record<string, string>> {
    if (this.oauthConfigured) {
      const token = await this.getOAuthToken();
      return { Authorization: `Bearer ${token.accessToken}` };
    }
    return { 'x-api-key': this.apiKey };
  }

  // ─── Chat ────────────────────────────────────────────────────────────

  async chat(messages: ChatMessage[], opts?: ChatOptions): Promise<ChatResponse> {
    const model = opts?.model || this.model;

    // Separate system prompt from messages — Anthropic wants it top-level.
    let systemPrompt = opts?.systemPrompt;
    const anthropicMessages: AnthropicMessage[] = [];

    for (const msg of messages) {
      if (msg.role === 'system') {
        // Merge multiple system messages (rare but possible).
        systemPrompt = systemPrompt
          ? `${systemPrompt}\n\n${sanitizeForJsonRequest(msg.content)}`
          : sanitizeForJsonRequest(msg.content);
        continue;
      }

      if (msg.role === 'tool') {
        // Anthropic tool results are user messages with tool_result content blocks.
        anthropicMessages.push({
          role: 'user',
          content: [
            {
              type: 'tool_result',
              tool_use_id: msg.tool_call_id,
              content: sanitizeForJsonRequest(msg.content),
            },
          ],
        });
        continue;
      }

      if (msg.role === 'assistant' && msg.tool_calls?.length) {
        // Assistant message with tool calls → content blocks.
        const blocks: AnthropicContentBlock[] = [];
        if (msg.content) {
          blocks.push({ type: 'text', text: sanitizeForJsonRequest(msg.content) });
        }
        for (const tc of msg.tool_calls) {
          blocks.push({
            type: 'tool_use',
            id: tc.id,
            name: tc.name,
            input: tc.arguments,
          });
        }
        anthropicMessages.push({ role: 'assistant', content: blocks });
        continue;
      }

      anthropicMessages.push({
        role: msg.role as 'user' | 'assistant',
        content: sanitizeForJsonRequest(msg.content),
      });
    }

    // Build tools array in Anthropic format.
    const tools: AnthropicTool[] | undefined = opts?.tools?.map(
      (t: ChatToolDefinition) => ({
        name: t.name,
        description: t.description,
        input_schema: t.inputSchema,
      }),
    );

    const body: AnthropicRequestBody = {
      model,
      max_tokens: opts?.maxTokens ?? DEFAULT_MAX_TOKENS,
      messages: anthropicMessages,
    };

    if (systemPrompt) body.system = sanitizeForJsonRequest(systemPrompt);
    if (opts?.temperature !== undefined) body.temperature = opts.temperature;
    if (tools?.length) body.tools = tools;

    const authHeaders = await this.resolveAuthHeaders();

    const r = await fetch(`${this.baseUrl}/v1/messages`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'anthropic-version': ANTHROPIC_API_VERSION,
        ...authHeaders,
      },
      body: JSON.stringify(body),
    });

    if (!r.ok) {
      const errorBody = (await r.json().catch(() => null)) as AnthropicErrorResponse | null;
      const detail = errorBody?.error?.message ?? (await r.text().catch(() => ''));
      throw new Error(`Anthropic error ${r.status}: ${detail}`);
    }

    const data = (await r.json()) as AnthropicResponse;

    // Extract text content and tool calls from response content blocks.
    const textParts: string[] = [];
    const toolCalls: ChatToolCall[] = [];

    for (const block of data.content) {
      if (block.type === 'text') {
        textParts.push(block.text);
      } else if (block.type === 'tool_use') {
        toolCalls.push({
          id: block.id,
          name: block.name,
          arguments: block.input,
        });
      }
    }

    return {
      content: textParts.join(''),
      model: data.model,
      provider: 'anthropic',
      tokens: {
        prompt: data.usage.input_tokens,
        completion: data.usage.output_tokens,
        total: data.usage.input_tokens + data.usage.output_tokens,
      },
      tool_calls: toolCalls.length ? toolCalls : undefined,
    };
  }
}
