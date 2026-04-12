/**
 * memphis_web_search — web search via DuckDuckGo HTML API (no key needed).
 */

export type MemphisWebSearchInput = {
  query: string;
  limit?: number;
};

export type SearchResult = {
  title: string;
  url: string;
  snippet: string;
};

export type MemphisWebSearchOutput = {
  query: string;
  results: SearchResult[];
  count: number;
  error?: string;
};

const MAX_RESULTS = 10;
const TIMEOUT_MS = 15_000;

function parseHtmlResults(html: string): SearchResult[] {
  const results: SearchResult[] = [];
  // DuckDuckGo HTML results use <a class="result__a" href="...">title</a>
  // and <a class="result__snippet" ...>snippet</a>
  const resultBlocks = html.split(/class="result__body"/);

  for (let i = 1; i < resultBlocks.length; i++) {
    const block = resultBlocks[i]!;
    // Extract URL from result__a href
    const urlMatch = block.match(/class="result__a"[^>]*href="([^"]+)"/);
    // Extract title text
    const titleMatch = block.match(/class="result__a"[^>]*>([^<]+)</);
    // Extract snippet
    const snippetMatch = block.match(/class="result__snippet"[^>]*>([^<]*(?:<[^>]*>[^<]*)*)<\/a>/);

    if (urlMatch?.[1] && titleMatch?.[1]) {
      let url = urlMatch[1];
      // DuckDuckGo wraps URLs in a redirect; extract the actual URL
      const uddgMatch = url.match(/uddg=([^&]+)/);
      if (uddgMatch?.[1]) {
        url = decodeURIComponent(uddgMatch[1]);
      }
      results.push({
        title: titleMatch[1].trim(),
        url,
        snippet: snippetMatch?.[1]
          ? snippetMatch[1].replace(/<[^>]*>/g, '').trim()
          : '',
      });
    }
  }
  return results;
}

export async function runMemphisWebSearch(
  input: MemphisWebSearchInput,
): Promise<MemphisWebSearchOutput> {
  const limit = Math.min(input.limit ?? 5, MAX_RESULTS);

  if (!input.query || input.query.trim().length === 0) {
    return { query: input.query, results: [], count: 0, error: 'Query is empty' };
  }

  try {
    const url = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(input.query)}`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

    const response = await fetch(url, {
      headers: {
        'User-Agent': 'Memphis-Agent/1.0 (sovereign-runtime)',
        'Accept': 'text/html',
      },
      signal: controller.signal,
    });

    clearTimeout(timer);

    if (!response.ok) {
      return {
        query: input.query,
        results: [],
        count: 0,
        error: `Search request failed: HTTP ${response.status}`,
      };
    }

    const html = await response.text();
    const allResults = parseHtmlResults(html);
    const results = allResults.slice(0, limit);

    return {
      query: input.query,
      results,
      count: results.length,
    };
  } catch (err) {
    return {
      query: input.query,
      results: [],
      count: 0,
      error: `Search failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}
