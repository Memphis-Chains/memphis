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
const DEFAULT_MODEL = 'claude-opus-4-6';
const DEFAULT_MAX_TOKENS = 4096;
const DEFAULT_MODEL_FALLBACK_CHAIN = 'claude-opus-4-7';

/** Refresh token 60 s before actual expiry to avoid mid-request failures. */
const TOKEN_EXPIRY_BUFFER_MS = 60_000;

/**
 * Per-model output-token caps. Keep conservative defaults that match
 * Anthropic's published limits at writing time — operators can override
 * via `ANTHROPIC_MODEL_OUTPUT_CAP_<MODEL>` if a newer model raises the
 * ceiling. The clamp protects against the operator's GEN_MAX_TOKENS
 * env (often set to 128k for Opus self-modify) overshooting on a
 * smaller model and triggering an Anthropic 400.
 *
 * Lookup is prefix-based — caller passes the model id, we match the
 * longest prefix in the table. Unknown models fall back to a defensive
 * 32k cap (the smallest current Anthropic supports).
 */
const MODEL_OUTPUT_CAPS: ReadonlyArray<readonly [string, number]> = [
  ['claude-opus-4-7', 32_000],
  ['claude-opus-4-6', 32_000],
  ['claude-sonnet-4-6', 64_000],
  ['claude-sonnet-4-5', 64_000],
  ['claude-haiku-4-5', 32_000],
];

/**
 * Determine whether an error from a model attempt should trigger a
 * fallback to the next model in the chain. We retry on:
 *   - HTTP 5xx (server-side, including 529 "overloaded")
 *   - HTTP 404 (model id not recognized — typical when an operator
 *     pins a deprecated model and a newer one is needed)
 *   - request-side timeouts (`AbortError`, ECONNRESET, ETIMEDOUT)
 *
 * We do NOT retry on:
 *   - HTTP 400 (request malformed — same payload to a different model
 *     would still be malformed)
 *   - HTTP 401/403 (auth — fallback won't help)
 *   - HTTP 429 (rate limit — same account hits the same limit)
 *
 * Cache hit rate observation: each model has its own cache prefix so
 * a fallback cold-misses cache. That's expected; we'd rather pay the
 * miss than fail the turn.
 */
function isModelFallbackTriggerError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  // Match `Anthropic error <STATUS>:` lines emitted by `chat()` below.
  const statusMatch = /Anthropic error (\d{3}):/.exec(msg);
  if (statusMatch) {
    const status = Number(statusMatch[1]);
    if (status >= 500) return true;
    if (status === 404) return true;
    return false;
  }
  // Network / timeout shapes from fetch + node:https.
  if (/ETIMEDOUT|ECONNRESET|ECONNREFUSED|EAI_AGAIN|AbortError|aborted/i.test(msg)) {
    return true;
  }
  return false;
}

function parseModelFallbackChain(raw: string | undefined): string[] {
  if (!raw) return [];
  return raw
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

const FALLBACK_OUTPUT_CAP = 32_000;

function modelOutputCap(model: string): number {
  const normalized = model.toLowerCase();
  for (const [prefix, cap] of MODEL_OUTPUT_CAPS) {
    if (normalized.startsWith(prefix)) {
      return cap;
    }
  }
  return FALLBACK_OUTPUT_CAP;
}

function effectiveMaxTokens(
  model: string,
  requested: number,
  logger?: (msg: string) => void,
): number {
  const cap = modelOutputCap(model);
  if (requested <= cap) {
    return requested;
  }
  // Surface once per request — bulk telemetry can pick this up via the
  // existing security audit chain if operators want event-level tracking.
  logger?.(`anthropic: max_tokens clamped ${requested} → ${cap} for model=${model}`);
  return cap;
}

/**
 * Cache control gate. Default ON (`MEMPHIS_ANTHROPIC_CACHE=1`); operator
 * can disable per-process to compare cache-vs-no-cache cost or to
 * sidestep a cache-key drift bug if one is suspected. Mirrors the
 * `MEMPHIS_THINK_FILTER` env-gated post-processing pattern.
 */
function cacheEnabled(rawEnv: NodeJS.ProcessEnv = process.env): boolean {
  const raw = (rawEnv.MEMPHIS_ANTHROPIC_CACHE ?? '1').trim().toLowerCase();
  return raw === '1' || raw === 'true' || raw === 'yes' || raw === 'on';
}

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

interface AnthropicCacheControl {
  type: 'ephemeral';
}

interface AnthropicTool {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
  cache_control?: AnthropicCacheControl;
}

interface AnthropicSystemBlock {
  type: 'text';
  text: string;
  cache_control?: AnthropicCacheControl;
}

interface AnthropicRequestBody {
  model: string;
  max_tokens: number;
  messages: AnthropicMessage[];
  /**
   * Anthropic accepts both forms. Plain string is the legacy path;
   * the array-of-blocks form unlocks `cache_control` per block, which
   * is how we cache the (large, mostly-static) Memphis system prompt.
   */
  system?: string | AnthropicSystemBlock[];
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
  usage: {
    input_tokens: number;
    output_tokens: number;
    /** Tokens written to ephemeral cache on this turn (cache miss). */
    cache_creation_input_tokens?: number;
    /** Tokens read from ephemeral cache on this turn (cache hit). */
    cache_read_input_tokens?: number;
  };
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
  /**
   * Comma-separated chain of fallback models. When a request to the
   * primary model triggers a retry-eligible error (5xx / 404 / network
   * timeout), the adapter retries the same request against each entry
   * in order. Defaults to `claude-opus-4-7` so an operator pinning
   * `claude-opus-4-6` still gets a turn answered when 4-6 is
   * temporarily unavailable. Set empty string to disable.
   */
  modelFallback?: string;
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
  private readonly modelFallbackChain: readonly string[];
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
    // Build the fallback chain. Empty string in opts.modelFallback or
    // env var explicitly disables fallback. Unset → use the default
    // (claude-opus-4-7 — same family as the typical primary).
    const fallbackRaw =
      opts?.modelFallback !== undefined
        ? opts.modelFallback
        : (process.env.ANTHROPIC_MODEL_FALLBACK ?? DEFAULT_MODEL_FALLBACK_CHAIN);
    this.modelFallbackChain = parseModelFallbackChain(fallbackRaw).filter(
      (m) => m !== this.model, // never retry the same model immediately
    );
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
      'claude-opus-4-7',
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
    const primary = opts?.model || this.model;
    // If caller pinned an explicit model, honor that exclusively — they
    // asked for that specific model, not "anthropic, fallback whatever".
    const chain =
      opts?.model && opts.model !== this.model
        ? [opts.model]
        : [primary, ...this.modelFallbackChain];

    // Pre-process messages once so each retry doesn't redo the work.
    const prepared = this.prepareMessages(messages, opts);

    let lastError: Error | null = null;
    for (const tryModel of chain) {
      try {
        return await this.executeChat(tryModel, prepared, opts);
      } catch (err) {
        lastError = err instanceof Error ? err : new Error(String(err));
        if (!isModelFallbackTriggerError(err)) {
          throw lastError;
        }
        // Surface the fallback so operators see WHICH model failed, not
        // just that "anthropic was slow" — useful when an Opus
        // checkpoint deprecates and the chain auto-promotes to Opus 4.7.
        if (chain.length > 1) {
          console.warn(
            `anthropic: ${tryModel} failed (${lastError.message.slice(0, 120)}), trying next in fallback chain`,
          );
        }
      }
    }
    // Every model in the chain failed for retry-eligible reasons.
    throw lastError ?? new Error('anthropic: all models in fallback chain failed');
  }

  /**
   * Translate Memphis ChatMessage[] into Anthropic's wire format.
   * Hoisted out of `chat()` so retries against the fallback model
   * don't redo the work — the message bag is identical, only `model`
   * + `max_tokens` (per-model clamp) change between attempts.
   */
  private prepareMessages(
    messages: ChatMessage[],
    opts: ChatOptions | undefined,
  ): {
    systemPrompt?: string;
    anthropicMessages: AnthropicMessage[];
    tools?: AnthropicTool[];
  } {
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

    return { systemPrompt, anthropicMessages, tools };
  }

  private async executeChat(
    model: string,
    prepared: ReturnType<AnthropicProvider['prepareMessages']>,
    opts: ChatOptions | undefined,
  ): Promise<ChatResponse> {
    const { systemPrompt, anthropicMessages, tools: preparedTools } = prepared;

    // Per-model output-token clamp. Operators set GEN_MAX_TOKENS in
    // `.env` (often 128k for Opus self-modify); a smaller model would
    // 400 on the request. Clamp at request build time and surface the
    // adjustment so the budget log records the effective cap.
    const requestedMaxTokens = opts?.maxTokens ?? DEFAULT_MAX_TOKENS;
    const clampedMaxTokens = effectiveMaxTokens(model, requestedMaxTokens, (msg) => {
      console.warn(msg);
    });

    const body: AnthropicRequestBody = {
      model,
      max_tokens: clampedMaxTokens,
      messages: anthropicMessages,
    };

    const useCaching = cacheEnabled();

    if (systemPrompt) {
      if (useCaching) {
        // Array form unlocks cache_control per block. The Memphis system
        // prompt is ~10k tokens of mostly-static tool catalog + autonomy
        // doc; caching cuts per-turn input cost ~10x within the 5-min TTL.
        body.system = [{ type: 'text', text: systemPrompt, cache_control: { type: 'ephemeral' } }];
      } else {
        body.system = systemPrompt;
      }
    }
    if (opts?.temperature !== undefined) body.temperature = opts.temperature;
    if (preparedTools?.length) {
      // Clone before mutation so the prepared bundle stays reusable
      // across retry attempts in the fallback chain.
      const tools = preparedTools.map((t) => ({ ...t }));
      if (useCaching) {
        // Anthropic semantics: a cache breakpoint on block N caches
        // block N AND every preceding block as one cache prefix. So a
        // single breakpoint on the last tool covers the whole tools
        // array — no need to mark every entry.
        const last = tools[tools.length - 1];
        tools[tools.length - 1] = { ...last, cache_control: { type: 'ephemeral' } };
      }
      body.tools = tools;
    }

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

    const cacheCreation = data.usage.cache_creation_input_tokens;
    const cacheRead = data.usage.cache_read_input_tokens;

    return {
      content: textParts.join(''),
      model: data.model,
      provider: 'anthropic',
      tokens: {
        prompt: data.usage.input_tokens,
        completion: data.usage.output_tokens,
        total: data.usage.input_tokens + data.usage.output_tokens,
        ...(cacheCreation !== undefined ? { cache_creation: cacheCreation } : {}),
        ...(cacheRead !== undefined ? { cache_read: cacheRead } : {}),
      },
      tool_calls: toolCalls.length ? toolCalls : undefined,
    };
  }
}

// ─── Test seam exports ───────────────────────────────────────────────────
//
// Tests pull these helpers directly to assert behavior without spinning
// up a fake HTTP server. They're intentionally not part of the public
// provider API — operators interact via env vars + `chat()`.

export const __anthropicAdapterTestExports = {
  effectiveMaxTokens,
  modelOutputCap,
  cacheEnabled,
  isModelFallbackTriggerError,
  parseModelFallbackChain,
};
