import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  AnthropicProvider,
  __anthropicAdapterTestExports,
} from '../../src/providers/anthropic/adapter.js';
import type { ChatMessage, ChatToolDefinition } from '../../src/providers/index.js';

/**
 * Anthropic adapter — caching + per-model clamp + cache-token roundtrip.
 *
 * The adapter writes `cache_control: { type: 'ephemeral' }` onto the
 * system prompt block and the LAST tool definition when caching is
 * enabled (default). Cache-stability is critical: any non-determinism
 * in the system prompt or tool ordering silently zeros the hit rate
 * because the cache key is a hash of the cached prefix.
 */

interface CapturedRequest {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: Record<string, unknown>;
}

function mockFetchCapturing(response: Record<string, unknown>): {
  fetch: typeof globalThis.fetch;
  captured: CapturedRequest[];
} {
  const captured: CapturedRequest[] = [];
  const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.toString();
    const headers = init?.headers as Record<string, string>;
    const bodyText = typeof init?.body === 'string' ? init.body : '';
    captured.push({
      url,
      method: init?.method ?? 'GET',
      headers,
      body: bodyText ? JSON.parse(bodyText) : {},
    });
    return new Response(JSON.stringify(response), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  });
  return { fetch: fetch as unknown as typeof globalThis.fetch, captured };
}

const SAMPLE_RESPONSE = {
  id: 'msg_test',
  type: 'message',
  role: 'assistant',
  content: [{ type: 'text', text: 'pong' }],
  model: 'claude-sonnet-4-6',
  stop_reason: 'end_turn',
  usage: {
    input_tokens: 12,
    output_tokens: 5,
    cache_creation_input_tokens: 8000,
    cache_read_input_tokens: 0,
  },
};

const SAMPLE_TOOL: ChatToolDefinition = {
  name: 'memphis_recall',
  description: 'Recall',
  inputSchema: { type: 'object', properties: { query: { type: 'string' } } },
};

const SAMPLE_TOOL_2: ChatToolDefinition = {
  name: 'memphis_search',
  description: 'Search',
  inputSchema: { type: 'object', properties: { q: { type: 'string' } } },
};

describe('AnthropicProvider — prompt caching', () => {
  const originalFetch = globalThis.fetch;
  const originalEnv = { ...process.env };

  beforeEach(() => {
    process.env.ANTHROPIC_API_KEY = 'sk-test';
    delete process.env.ANTHROPIC_OAUTH_REFRESH_TOKEN;
    delete process.env.ANTHROPIC_OAUTH_CLIENT_ID;
    delete process.env.ANTHROPIC_OAUTH_CLIENT_SECRET;
    delete process.env.MEMPHIS_ANTHROPIC_CACHE;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    process.env = { ...originalEnv };
  });

  it('writes cache_control on system block + last tool when caching is enabled (default)', async () => {
    const { fetch, captured } = mockFetchCapturing(SAMPLE_RESPONSE);
    globalThis.fetch = fetch;

    const provider = new AnthropicProvider({ apiKey: 'sk-test' });
    await provider.chat([{ role: 'user', content: 'ping' }] as ChatMessage[], {
      systemPrompt: 'Memphis system prompt body — many tokens.',
      tools: [SAMPLE_TOOL, SAMPLE_TOOL_2],
    });

    expect(captured).toHaveLength(1);
    const body = captured[0].body;

    // System is array form with cache_control.
    expect(Array.isArray(body.system)).toBe(true);
    const systemBlocks = body.system as Array<{
      type: string;
      text: string;
      cache_control?: { type: string };
    }>;
    expect(systemBlocks).toHaveLength(1);
    expect(systemBlocks[0].type).toBe('text');
    expect(systemBlocks[0].cache_control).toEqual({ type: 'ephemeral' });

    // LAST tool has cache_control; earlier tools do not.
    const tools = body.tools as Array<{ name: string; cache_control?: { type: string } }>;
    expect(tools).toHaveLength(2);
    expect(tools[0].cache_control).toBeUndefined();
    expect(tools[1].cache_control).toEqual({ type: 'ephemeral' });
  });

  it('omits cache_control when MEMPHIS_ANTHROPIC_CACHE=0', async () => {
    process.env.MEMPHIS_ANTHROPIC_CACHE = '0';
    const { fetch, captured } = mockFetchCapturing(SAMPLE_RESPONSE);
    globalThis.fetch = fetch;

    const provider = new AnthropicProvider({ apiKey: 'sk-test' });
    await provider.chat([{ role: 'user', content: 'ping' }] as ChatMessage[], {
      systemPrompt: 'system body',
      tools: [SAMPLE_TOOL],
    });

    const body = captured[0].body;
    // System is plain string form.
    expect(typeof body.system).toBe('string');
    const tools = body.tools as Array<{ name: string; cache_control?: unknown }>;
    expect(tools[0].cache_control).toBeUndefined();
  });

  it('forwards cache_creation_input_tokens / cache_read_input_tokens into ChatResponse.tokens', async () => {
    const { fetch } = mockFetchCapturing({
      ...SAMPLE_RESPONSE,
      usage: {
        input_tokens: 100,
        output_tokens: 20,
        cache_creation_input_tokens: 9500,
        cache_read_input_tokens: 8000,
      },
    });
    globalThis.fetch = fetch;

    const provider = new AnthropicProvider({ apiKey: 'sk-test' });
    const result = await provider.chat([{ role: 'user', content: 'ping' }] as ChatMessage[], {
      systemPrompt: 'system body',
    });

    expect(result.tokens?.cache_creation).toBe(9500);
    expect(result.tokens?.cache_read).toBe(8000);
    expect(result.tokens?.prompt).toBe(100);
    expect(result.tokens?.completion).toBe(20);
  });

  it('omits cache fields from ChatResponse.tokens when API does not return them', async () => {
    const { fetch } = mockFetchCapturing({
      ...SAMPLE_RESPONSE,
      usage: { input_tokens: 50, output_tokens: 10 },
    });
    globalThis.fetch = fetch;

    const provider = new AnthropicProvider({ apiKey: 'sk-test' });
    const result = await provider.chat([{ role: 'user', content: 'ping' }] as ChatMessage[]);

    expect(result.tokens?.cache_creation).toBeUndefined();
    expect(result.tokens?.cache_read).toBeUndefined();
  });
});

describe('AnthropicProvider — per-model max_tokens clamp', () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('clamps requested max_tokens to model cap (Sonnet 64k, Haiku 32k)', () => {
    const { effectiveMaxTokens } = __anthropicAdapterTestExports;
    expect(effectiveMaxTokens('claude-sonnet-4-6', 128_000)).toBe(64_000);
    expect(effectiveMaxTokens('claude-sonnet-4-5-20250514', 128_000)).toBe(64_000);
    expect(effectiveMaxTokens('claude-haiku-4-5-20251001', 128_000)).toBe(32_000);
    expect(effectiveMaxTokens('claude-opus-4-7', 128_000)).toBe(32_000);
    expect(effectiveMaxTokens('claude-opus-4-6', 128_000)).toBe(32_000);
  });

  it('passes requested max_tokens through when at or below cap', () => {
    const { effectiveMaxTokens } = __anthropicAdapterTestExports;
    expect(effectiveMaxTokens('claude-sonnet-4-6', 32_000)).toBe(32_000);
    expect(effectiveMaxTokens('claude-sonnet-4-6', 64_000)).toBe(64_000);
    expect(effectiveMaxTokens('claude-haiku-4-5', 4_096)).toBe(4_096);
  });

  it('falls back to 32k for unknown model', () => {
    const { effectiveMaxTokens } = __anthropicAdapterTestExports;
    expect(effectiveMaxTokens('claude-unknown-model', 128_000)).toBe(32_000);
  });

  it('logs a warn when clamping occurs', () => {
    const { effectiveMaxTokens } = __anthropicAdapterTestExports;
    const logger = vi.fn();
    effectiveMaxTokens('claude-haiku-4-5-20251001', 128_000, logger);
    expect(logger).toHaveBeenCalledWith(
      expect.stringContaining('max_tokens clamped 128000 → 32000'),
    );
  });

  it('actually applies the clamp on the wire request body', async () => {
    const { fetch, captured } = mockFetchCapturing({
      ...SAMPLE_RESPONSE,
      model: 'claude-haiku-4-5-20251001',
    });
    globalThis.fetch = fetch;

    const provider = new AnthropicProvider({
      apiKey: 'sk-test',
      model: 'claude-haiku-4-5-20251001',
    });
    await provider.chat([{ role: 'user', content: 'ping' }] as ChatMessage[], {
      maxTokens: 128_000,
    });

    expect(captured[0].body.max_tokens).toBe(32_000);
  });
});

describe('AnthropicProvider — cache-key stability', () => {
  /**
   * Cache hit rate goes to zero if any non-determinism leaks into the
   * system prompt body or tools list. Two consecutive builds of the
   * same `chat()` call against the same fetch capture must produce
   * byte-identical JSON in the cached fields. Operators rely on this
   * to keep cost predictable.
   */
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('produces byte-identical request bodies across two chat() calls with the same inputs', async () => {
    const { fetch: fetch1, captured: cap1 } = mockFetchCapturing(SAMPLE_RESPONSE);
    globalThis.fetch = fetch1;
    const provider1 = new AnthropicProvider({ apiKey: 'sk-test' });
    await provider1.chat([{ role: 'user', content: 'ping' }] as ChatMessage[], {
      systemPrompt: 'memphis system prompt — deterministic',
      tools: [SAMPLE_TOOL, SAMPLE_TOOL_2],
    });

    const { fetch: fetch2, captured: cap2 } = mockFetchCapturing(SAMPLE_RESPONSE);
    globalThis.fetch = fetch2;
    const provider2 = new AnthropicProvider({ apiKey: 'sk-test' });
    await provider2.chat([{ role: 'user', content: 'ping' }] as ChatMessage[], {
      systemPrompt: 'memphis system prompt — deterministic',
      tools: [SAMPLE_TOOL, SAMPLE_TOOL_2],
    });

    // Strip messages (user content varies turn to turn) and compare the
    // cached fields: system + tools.
    const cached1 = { system: cap1[0].body.system, tools: cap1[0].body.tools };
    const cached2 = { system: cap2[0].body.system, tools: cap2[0].body.tools };
    expect(JSON.stringify(cached1)).toBe(JSON.stringify(cached2));
  });
});
