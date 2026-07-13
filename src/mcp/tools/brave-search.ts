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
 * `BRAVE_API_KEY` env (vault refs `VAULT:brave_api_key` are resolved
 * upstream by `resolveVaultSecrets()` in src/infra/cli/index.ts, so
 * by the time this runs the env var holds the literal key).
 *
 * API docs: https://api.search.brave.com/app/documentation
 */

import { MEMPHIS_BRAVE_SEARCH_TIMEOUT_MS } from '../../config/env-registry.js';

const BRAVE_SEARCH_ENDPOINT = 'https://api.search.brave.com/res/v1/web/search';
const MAX_RESULTS = 20;
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

interface BraveResponse {
  web?: { results?: BraveWebItem[] };
  news?: { results?: BraveWebItem[] };
}

function pickResults(items: BraveWebItem[] | undefined, source: 'web' | 'news'): BraveSearchResult[] {
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

function describeFetchError(err: unknown): string {
  if (!(err instanceof Error)) return String(err);
  const cause = (err as Error & { cause?: unknown }).cause;
  if (cause instanceof Error) {
    const code = (cause as Error & { code?: string }).code;
    return code ? `${err.message} (${code}: ${cause.message})` : `${err.message} (${cause.message})`;
  }
  return err.message;
}

export async function runMemphisBraveSearch(
  input: MemphisBraveSearchInput,
  rawEnv: NodeJS.ProcessEnv = process.env,
): Promise<MemphisBraveSearchOutput> {
  const limit = Math.min(Math.max(input.limit ?? 10, 1), MAX_RESULTS);

  if (!input.query || input.query.trim().length === 0) {
    return { query: input.query ?? '', results: [], count: 0, error: 'Query is empty' };
  }

  const apiKey = rawEnv.BRAVE_API_KEY?.trim();
  if (!apiKey || apiKey.startsWith('VAULT:')) {
    // Vault prefix means the upstream resolver did NOT manage to expand
    // it — usually because vault wasn't initialized or the entry name
    // doesn't exist. Surface a precise error so the operator knows
    // exactly what to fix.
    return {
      query: input.query,
      results: [],
      count: 0,
      error:
        apiKey?.startsWith('VAULT:') ?? false
          ? `BRAVE_API_KEY references vault entry "${apiKey?.slice(6)}" but vault didn't resolve it. Run \`memphis brave configure --key <token>\` or set BRAVE_API_KEY directly.`
          : 'BRAVE_API_KEY not set. Get a key at https://api.search.brave.com/ (free 2000 queries/month), then run `memphis brave configure --key <token>`.',
    };
  }

  const params = new URLSearchParams({
    q: input.query,
    count: String(limit),
  });
  if (input.country) params.set('country', input.country);
  if (input.search_lang) params.set('search_lang', input.search_lang);

  const url = `${BRAVE_SEARCH_ENDPOINT}?${params.toString()}`;

  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

    const response = await fetch(url, {
      headers: {
        Accept: 'application/json',
        'Accept-Encoding': 'gzip',
        'X-Subscription-Token': apiKey,
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
    const webResults = pickResults(data.web?.results, 'web');
    const newsResults = pickResults(data.news?.results, 'news');
    const merged = [...webResults, ...newsResults].slice(0, limit);

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
