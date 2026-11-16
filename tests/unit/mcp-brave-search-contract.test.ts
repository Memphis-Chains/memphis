import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { runMemphisBraveSearch } from '../../src/mcp/tools/brave-search.js';

/**
 * The TypeScript arm of `memphis_brave_search`, checked against the cases
 * where it and the native arm must answer the same way.
 *
 * `tests/fixtures/brave-search-contract.json` holds the cases; the native
 * runner is `crates/memphis-operator/tests/brave_search_contract.rs`. A
 * change in one arm that the other does not share fails a test in BOTH
 * languages.
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE_PATH = path.join(here, '..', 'fixtures', 'brave-search-contract.json');

type ContractResult = { title: string; url: string; description: string; source: string };

type ContractCase = {
  name: string;
  call: {
    query: string;
    limit?: number;
    country?: string;
    search_lang?: string;
    key?: string;
  };
  response?: { status: number; body?: unknown; bodyText?: string };
  expect: {
    ok: boolean;
    count?: number;
    url?: string;
    params?: Record<string, string>;
    results?: ContractResult[];
    error?: string;
    noRequest?: boolean;
  };
};

const fixture = JSON.parse(readFileSync(FIXTURE_PATH, 'utf8')) as { cases: ContractCase[] };

describe('memphis_brave_search — the two arms agree', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it.each(fixture.cases)('$name', async (fixtureCase) => {
    const requested: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: unknown) => {
        requested.push(String(url));
        const response = fixtureCase.response;
        if (!response) {
          throw new Error('the arm must not make a request in this case');
        }
        const body = response.bodyText ?? JSON.stringify(response.body ?? {});
        return new Response(body, { status: response.status });
      }),
    );

    // The vault is never touched: a `VAULT:` reference that cannot be
    // resolved must produce the refusal that names the entry.
    const resolveSecret = vi.fn(() => undefined);

    const output = await runMemphisBraveSearch(
      {
        query: fixtureCase.call.query,
        limit: fixtureCase.call.limit,
        country: fixtureCase.call.country,
        search_lang: fixtureCase.call.search_lang,
      },
      fixtureCase.call.key === undefined ? {} : { BRAVE_API_KEY: fixtureCase.call.key },
      resolveSecret,
    );

    const expectation = fixtureCase.expect;

    if (!expectation.ok) {
      expect(output.error).toBe(expectation.error);
      expect(output.count).toBe(0);
      if (expectation.noRequest) expect(requested).toEqual([]);
      return;
    }

    expect(output.error).toBeUndefined();

    if (expectation.count !== undefined) expect(output.count).toBe(expectation.count);

    if (expectation.url !== undefined) expect(requested[0]).toBe(expectation.url);

    if (expectation.params !== undefined) {
      const params = new URL(requested[0]).searchParams;
      for (const [name, value] of Object.entries(expectation.params)) {
        expect(params.get(name)).toBe(value);
      }
    }

    if (expectation.results !== undefined) {
      expect(output.results).toEqual(expectation.results);
    }
  });
});
