/**
 * Unit tests for memphis_brave_search adapter.
 *
 * The adapter is a thin HTTP wrapper over Brave's web search endpoint.
 * Tests use vi-mocked global.fetch to exercise auth-key handling,
 * error paths (missing key, vault-unresolved key, HTTP errors), and
 * the response-shaping happy path.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

import { runMemphisBraveSearch } from '../../src/mcp/tools/brave-search.js';

const ORIGINAL_FETCH = globalThis.fetch;

function mockFetch(
  shape:
    | { ok: true; status?: number; body: unknown }
    | { ok: false; status: number; text: string },
): ReturnType<typeof vi.fn> {
  const fn = vi.fn(async () => {
    if (shape.ok) {
      return new Response(JSON.stringify(shape.body), {
        status: shape.status ?? 200,
        headers: { 'content-type': 'application/json' },
      });
    }
    return new Response(shape.text, { status: shape.status });
  });
  globalThis.fetch = fn as unknown as typeof globalThis.fetch;
  return fn;
}

describe('runMemphisBraveSearch', () => {
  afterEach(() => {
    globalThis.fetch = ORIGINAL_FETCH;
    vi.restoreAllMocks();
  });

  // ── Empty / missing input handling ───────────────────────────────────

  it('returns Query is empty error for blank queries', async () => {
    const out = await runMemphisBraveSearch({ query: '' }, { BRAVE_API_KEY: 'k' });
    expect(out.error).toBe('Query is empty');
    expect(out.results).toHaveLength(0);
  });

  it('returns Query is empty error for whitespace-only queries', async () => {
    const out = await runMemphisBraveSearch({ query: '   ' }, { BRAVE_API_KEY: 'k' });
    expect(out.error).toBe('Query is empty');
  });

  // ── API key resolution ───────────────────────────────────────────────

  it('returns BRAVE_API_KEY-not-set error with a helpful hint when key is missing', async () => {
    const out = await runMemphisBraveSearch({ query: 'foo' }, {});
    expect(out.error).toContain('BRAVE_API_KEY not set');
    expect(out.error).toContain('https://api.search.brave.com/');
    expect(out.error).toContain('memphis vault add brave_api_key');
  });

  it('returns vault-unresolved error when env still holds VAULT: prefix at runtime', async () => {
    const out = await runMemphisBraveSearch(
      { query: 'foo' },
      { BRAVE_API_KEY: 'VAULT:brave_api_key' },
    );
    expect(out.error).toContain('vault entry "brave_api_key"');
    expect(out.error).toContain("vault didn't resolve");
    expect(out.error).toContain('memphis vault add brave_api_key');
  });

  // ── HTTP error responses ─────────────────────────────────────────────

  it('annotates 401 with "BRAVE_API_KEY rejected" hint', async () => {
    mockFetch({ ok: false, status: 401, text: '{"error":"Invalid key"}' });
    const out = await runMemphisBraveSearch({ query: 'foo' }, { BRAVE_API_KEY: 'bad-key' });
    expect(out.error).toContain('HTTP 401');
    expect(out.error).toContain('BRAVE_API_KEY rejected');
  });

  it('annotates 429 with rate-limit hint', async () => {
    mockFetch({ ok: false, status: 429, text: 'Too many requests' });
    const out = await runMemphisBraveSearch({ query: 'foo' }, { BRAVE_API_KEY: 'k' });
    expect(out.error).toContain('HTTP 429');
    expect(out.error).toContain('rate limit');
  });

  it('returns a generic error for other HTTP failures', async () => {
    mockFetch({ ok: false, status: 500, text: 'server boom' });
    const out = await runMemphisBraveSearch({ query: 'foo' }, { BRAVE_API_KEY: 'k' });
    expect(out.error).toContain('HTTP 500');
    expect(out.error).not.toContain('BRAVE_API_KEY rejected');
    expect(out.error).not.toContain('rate limit');
  });

  // ── Happy path ───────────────────────────────────────────────────────

  it('parses Brave web + news results into the unified shape', async () => {
    const fn = mockFetch({
      ok: true,
      body: {
        web: {
          results: [
            {
              title: 'Example domain',
              url: 'https://example.com/',
              description: 'Reserved for use in <strong>illustrative</strong> examples',
            },
            {
              title: 'Example 2',
              url: 'https://example.org/',
              description: 'Another example',
            },
          ],
        },
        news: {
          results: [
            { title: 'Live news', url: 'https://news.example.com/', description: 'Hot off' },
          ],
        },
      },
    });

    const out = await runMemphisBraveSearch(
      { query: 'illustrative example', limit: 10 },
      { BRAVE_API_KEY: 'sk-test' },
    );

    expect(out.error).toBeUndefined();
    expect(out.count).toBe(3);
    expect(out.results[0]).toEqual({
      title: 'Example domain',
      url: 'https://example.com/',
      // <strong> stripped from description
      description: 'Reserved for use in illustrative examples',
      source: 'web',
    });
    expect(out.results[2]).toMatchObject({
      url: 'https://news.example.com/',
      source: 'news',
    });
    // Verify request shape — auth header + query params
    const [url, init] = fn.mock.calls[0]!;
    expect(String(url)).toContain('api.search.brave.com');
    expect(String(url)).toContain('q=illustrative');
    expect(String(url)).toContain('count=10');
    const headers = (init as RequestInit).headers as Record<string, string>;
    expect(headers['X-Subscription-Token']).toBe('sk-test');
  });

  it('respects the limit parameter (caps at 20)', async () => {
    const fn = mockFetch({ ok: true, body: { web: { results: [] } } });
    await runMemphisBraveSearch(
      { query: 'foo', limit: 999 },
      { BRAVE_API_KEY: 'k' },
    );
    expect(String(fn.mock.calls[0]![0])).toContain('count=20');
  });

  it('uses default limit of 10 when not supplied', async () => {
    const fn = mockFetch({ ok: true, body: { web: { results: [] } } });
    await runMemphisBraveSearch({ query: 'foo' }, { BRAVE_API_KEY: 'k' });
    expect(String(fn.mock.calls[0]![0])).toContain('count=10');
  });

  it('forwards country + search_lang params when provided', async () => {
    const fn = mockFetch({ ok: true, body: { web: { results: [] } } });
    await runMemphisBraveSearch(
      { query: 'foo', country: 'PL', search_lang: 'pl' },
      { BRAVE_API_KEY: 'k' },
    );
    const url = String(fn.mock.calls[0]![0]);
    expect(url).toContain('country=PL');
    expect(url).toContain('search_lang=pl');
  });

  it('returns empty results gracefully when Brave returns no web/news arrays', async () => {
    mockFetch({ ok: true, body: {} });
    const out = await runMemphisBraveSearch({ query: 'foo' }, { BRAVE_API_KEY: 'k' });
    expect(out.error).toBeUndefined();
    expect(out.count).toBe(0);
    expect(out.results).toHaveLength(0);
  });

  it('truncates merged results to limit (web first, news appended)', async () => {
    mockFetch({
      ok: true,
      body: {
        web: {
          results: Array.from({ length: 8 }, (_, i) => ({
            title: `web ${i}`,
            url: `https://web${i}.example/`,
            description: '',
          })),
        },
        news: {
          results: Array.from({ length: 5 }, (_, i) => ({
            title: `news ${i}`,
            url: `https://news${i}.example/`,
            description: '',
          })),
        },
      },
    });
    const out = await runMemphisBraveSearch({ query: 'foo', limit: 5 }, { BRAVE_API_KEY: 'k' });
    expect(out.results).toHaveLength(5);
    // All 5 are from web (truncation prefers web ordering)
    expect(out.results.every((r) => r.source === 'web')).toBe(true);
  });

  // ── Network failures ─────────────────────────────────────────────────

  it('returns Brave Search failed error on network exception', async () => {
    globalThis.fetch = vi.fn(async () => {
      throw new Error('ENETUNREACH');
    }) as unknown as typeof globalThis.fetch;
    const out = await runMemphisBraveSearch({ query: 'foo' }, { BRAVE_API_KEY: 'k' });
    expect(out.error).toContain('Brave Search failed');
    expect(out.error).toContain('ENETUNREACH');
  });
});
