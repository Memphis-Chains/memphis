/* eslint-disable no-restricted-syntax */
//
// Anthropic provider adapter — sources its own ANTHROPIC_* env keys
// at constructor time. Keys live in mutability whitelist + provider
// catalog, but this file is the canonical reader for them. Same
// rationale as src/providers/index.ts.
//
/**
 * Native Anthropic Messages API provider.
 *
 * Supports three auth modes (in priority order):
 *   1. OAuth browser flow — refresh_token in vault → auto-refresh → Bearer token
 *   2. OAuth client_credentials — client_id + client_secret → token exchange
 *   3. API key fallback — static x-api-key header
 *
 * OAuth tokens are cached in memory and refreshed automatically before expiry.
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
import { refreshAccessToken, type OAuthFlowOptions } from './oauth-flow.js';

const ANTHROPIC_API_VERSION = '2023-06-01';
const DEFAULT_BASE_URL = 'https://api.anthropic.com';
const DEFAULT_OAUTH_TOKEN_URL = 'https://console.anthropic.com/oauth/token';
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
  /** Static API key (x-api-key auth). Lowest priority. */
  apiKey?: string;
  model?: string;
  baseUrl?: string;

  /** OAuth refresh token from browser flow (highest priority). */
  oauthRefreshToken?: string;

  /** OAuth client credentials (middle priority). */
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
  private readonly oauthRefreshToken: string;
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

    this.oauthRefreshToken =
      opts?.oauthRefreshToken || process.env.ANTHROPIC_OAUTH_REFRESH_TOKEN || '';
    this.oauthClientId = opts?.oauthClientId || process.env.ANTHROPIC_OAUTH_CLIENT_ID || '';
    this.oauthClientSecret =
      opts?.oauthClientSecret || process.env.ANTHROPIC_OAUTH_CLIENT_SECRET || '';
    this.oauthTokenUrl =
      opts?.oauthTokenUrl || process.env.ANTHROPIC_OAUTH_TOKEN_URL || DEFAULT_OAUTH_TOKEN_URL;
  }

  private get hasRefreshToken(): boolean {
    return !!this.oauthRefreshToken;
  }

  private get hasClientCredentials(): boolean {
    return !!(this.oauthClientId && this.oauthClientSecret);
  }

  isConfigured(): boolean {
    return this.hasRefreshToken || this.hasClientCredentials || !!this.apiKey;
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

  private async getOAuthToken(): Promise<OAuthToken> {
    if (this.cachedToken && Date.now() < this.cachedToken.expiresAt - TOKEN_EXPIRY_BUFFER_MS) {
      return this.cachedToken;
    }

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
    // Priority 1: refresh_token from browser flow
    if (this.hasRefreshToken) {
      const flowOpts: OAuthFlowOptions = {
        clientId: this.oauthClientId || undefined,
        tokenUrl: this.oauthTokenUrl,
      };
      const tokens = await refreshAccessToken(this.oauthRefreshToken, flowOpts);
      return {
        accessToken: tokens.access_token,
        expiresAt: Date.now() + tokens.expires_in * 1000,
      };
    }

    // Priority 2: client_credentials
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
   * Build auth headers.
   * OAuth (refresh or client_credentials) → Authorization: Bearer
   * API key → x-api-key
   */
  private async resolveAuthHeaders(): Promise<Record<string, string>> {
    if (this.hasRefreshToken || this.hasClientCredentials) {
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
        systemPrompt = systemPrompt
          ? `${systemPrompt}\n\n${sanitizeForJsonRequest(msg.content)}`
          : sanitizeForJsonRequest(msg.content);
        continue;
      }

      if (msg.role === 'tool') {
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

    const tools: AnthropicTool[] | undefined = opts?.tools?.map((t: ChatToolDefinition) => ({
      name: t.name,
      description: t.description,
      input_schema: t.inputSchema,
    }));

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
