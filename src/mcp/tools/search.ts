import { searchExactMemory, type ExactSearchOutput } from '../../infra/memory/exact-search.js';

export type MemphisSearchInput = {
  query: string;
  limit?: number;
  chain?: string;
};

export type MemphisSearchOutput = {
  results: ExactSearchOutput['hits'];
};

export type SearchDeps = {
  search: typeof searchExactMemory;
};

export function runMemphisSearch(
  input: MemphisSearchInput,
  deps: SearchDeps = { search: searchExactMemory },
): MemphisSearchOutput {
  const out = deps.search(input.query, input.limit ?? 5, undefined, input.chain);
  return {
    results: out.hits,
  };
}
