/**
 * memphis_brave_search — Brave Search API web search.
 *
 * Mirror of memphis_web_search (DuckDuckGo HTML scrape) but backed by
 * the Brave Search API for higher quality + structured results. Free
 * tier offers 2000 queries/month.
 *
 * Why both exist: DuckDuckGo HTML scraping is zero-config, no key, no
 * rate-limit visibility — works as a fallback. Brave API gives
 * structured JSON, news/locations/discussions extras, and predictable
 * rate limits — preferred when the operator has a key.
 *
 * Auth: header `X-Subscription-Token: <key>`. The key is read from
 * `BRAVE_API_KEY` env. A vault reference (`VAULT:brave_api_key`) is
 * resolved BY THIS ARM, not by the caller: the daemon's environment
 * carries the reference, not the secret, and the CLI resolves the
 * vault at startup while the daemon does not. An arm that trusted the
 * environment worked on one surface and refused on the other. The
 * provider already does this for provider keys (`*_VAULT_KEY`).
 *
 * The native arm in `crates/memphis-operator/src/brave_search.rs`
 * answers the same way for the same input — the shared case table in
 * `tests/fixtures/brave-search-contract.json` is what holds them
 * together, and a Rust test and a TypeScript test both run it.
 *
 * API docs: https://api.search.brave.com/app/documentation
 */

import { MEMPHIS_BRAVE_SEARCH_TIMEOUT_MS } from '../../config/env-registry.js';
import { resolveVaultSecret } from '../../infra/config/vault-resolve.js';

export const BRAVE_SEARCH_ENDPOINT = 'https://api.search.brave.com/res/v1/web/search';
/** The cap the tool schema advertises and the vendor accepts. */
export const BRAVE_SEARCH_MAX_RESULTS = 20;
/** The count used when the caller does not ask for one. */
export const BRAVE_SEARCH_DEFAULT_LIMIT = 10;
// Phase 1.5.3: env-driven via MEMPHIS_BRAVE_SEARCH_TIMEOUT_MS (default
// 1 min, was 15 s hardcode).
const TIMEOUT_MS = MEMPHIS_BRAVE_SEARCH_TIMEOUT_MS.read(process.env);

export type MemphisBraveSearchInput = {
  query: string;
  limit?: number;
  /**
   * Brave's `country` param (ISO 3166-1 alpha-2). Default unset = global.
   * Polish-language operator can pass 'PL' for region-localized results.
   */
  country?: string;
  /** Brave's `search_lang` param (ISO 639-1). Default unset = English. */
  search_lang?: string;
};

export type BraveSearchResult = {
  title: string;
  url: string;
  description: string;
  /** Where in Brave's response this came from (web | news). */
  source: 'web' | 'news';
};

export type MemphisBraveSearchOutput = {
  query: string;
  results: BraveSearchResult[];
  count: number;
  error?: string;
};

interface BraveWebItem {
  title?: string;
  url?: string;
  description?: string;
}

export interface BraveResponse {
  web?: { results?: BraveWebItem[] };
  news?: { results?: BraveWebItem[] };
}

/**
 * Clamp the requested count to what Brave accepts.
 *
 * The count is floored first: a fractional count reached the vendor as
 * `count=2.5` and was rejected there. The native arm does the same.
 */
export function braveSearchLimit(limit?: number): number {
  if (limit === undefined || limit === null || !Number.isFinite(limit)) {
    return BRAVE_SEARCH_DEFAULT_LIMIT;
  }
  const truncated = Math.trunc(limit);
  return Math.min(Math.max(truncated, 1), BRAVE_SEARCH_MAX_RESULTS);
}

/**
 * The refusal for a missing or unresolved credential, or undefined when
 * the key is usable. The wording is shared with the native arm.
 */
export function braveSearchKeyError(key?: string): string | undefined {
  const trimmed = key?.trim() ?? '';
  if (trimmed.length === 0) {
    return 'BRAVE_API_KEY not set. Get a key at https://api.search.brave.com/ (free 2000 queries/month), then run `memphis brave configure --key <token>`.';
  }
  if (trimmed.startsWith('VAULT:')) {
    return `BRAVE_API_KEY references vault entry "${trimmed.slice(6)}" but vault didn't resolve it. Run \`memphis brave configure --key <token>\` or set BRAVE_API_KEY directly.`;
  }
  return undefined;
}

/**
 * Build the request URL. Same endpoint, same parameter order, same
 * encoding as the native arm — `URLSearchParams` encodes the way the
 * native encoder does, so both arms ask the vendor for the same thing.
 */
export function braveSearchUrl(
  query: string,
  limit: number,
  country?: string,
  search_lang?: string,
): string {
  const params = new URLSearchParams({
    q: query,
    count: String(limit),
  });
  if (country) params.set('country', country);
  if (search_lang) params.set('search_lang', search_lang);
  return `${BRAVE_SEARCH_ENDPOINT}?${params.toString()}`;
}

function pickResults(
  items: BraveWebItem[] | undefined,
  source: 'web' | 'news',
): BraveSearchResult[] {
  if (!Array.isArray(items)) return [];
  return items
    .filter((item) => typeof item.url === 'string' && item.url.length > 0)
    .map((item) => ({
      title: (item.title ?? '').trim(),
      url: item.url!,
      description: (item.description ?? '').replace(/<[^>]*>/g, '').trim(),
      source,
    }));
}

/**
 * Parse a Brave payload: web results first, then news.
 */
export function parseBravePayload(payload: BraveResponse): BraveSearchResult[] {
  const webResults = pickResults(payload.web?.results, 'web');
  const newsResults = pickResults(payload.news?.results, 'news');
  return [...webResults, ...newsResults];
}

function describeFetchError(err: unknown): string {
  if (!(err instanceof Error)) return String(err);
  const cause = (err as Error & { cause?: unknown }).cause;
  if (cause instanceof Error) {
    const code = (cause as Error & { code?: string }).code;
    return code ? `${err.message} (${code}: ${cause.message})` : `${err.message} (${cause.message})`;
  }
  return err.message;
}

/**
 * Resolve a `VAULT:<entry>` reference. Injectable so the contract test
 * never touches the real vault.
 */
export type BraveSecretResolver = (
  value: string,
  env: NodeJS.ProcessEnv,
) => string | undefined;

export async function runMemphisBraveSearch(
  input: MemphisBraveSearchInput,
  rawEnv: NodeJS.ProcessEnv = process.env,
  resolveSecret: BraveSecretResolver = resolveVaultSecret,
): Promise<MemphisBraveSearchOutput> {
  const limit = braveSearchLimit(input.limit);

  if (!input.query || input.query.trim().length === 0) {
    return { query: input.query ?? '', results: [], count: 0, error: 'Query is empty' };
  }

  let apiKey = rawEnv.BRAVE_API_KEY?.trim();
  if (apiKey?.startsWith('VAULT:')) {
    // Keep the reference when it cannot be resolved, so the refusal
    // names the entry the operator has to fix.
    apiKey = resolveSecret(apiKey, rawEnv)?.trim() || apiKey;
  }
  const refusal = braveSearchKeyError(apiKey);
  if (refusal) {
    return { query: input.query, results: [], count: 0, error: refusal };
  }

  const url = braveSearchUrl(input.query, limit, input.country, input.search_lang);

  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

    const response = await fetch(url, {
      headers: {
        Accept: 'application/json',
        'Accept-Encoding': 'gzip',
        'X-Subscription-Token': apiKey!,
        'User-Agent': 'Memphis-Agent/1.0 (sovereign-runtime)',
      },
      signal: controller.signal,
    });

    clearTimeout(timer);

    if (!response.ok) {
      const body = await response.text().catch(() => '');
      // Brave returns 401 on bad key, 429 on rate limit, 422 on bad query
      let hint = '';
      if (response.status === 401) hint = ' (BRAVE_API_KEY rejected — check it)';
      else if (response.status === 429) hint = ' (rate limit hit — Brave free tier is 1 query/sec)';
      return {
        query: input.query,
        results: [],
        count: 0,
        error: `Brave Search API error: HTTP ${response.status}${hint} ${body.slice(0, 200)}`,
      };
    }

    const data = (await response.json()) as BraveResponse;
    const merged = parseBravePayload(data).slice(0, limit);

    return {
      query: input.query,
      results: merged,
      count: merged.length,
    };
  } catch (err) {
    return {
      query: input.query,
      results: [],
      count: 0,
      error: `Brave Search failed: ${describeFetchError(err)}`,
    };
  }
}
