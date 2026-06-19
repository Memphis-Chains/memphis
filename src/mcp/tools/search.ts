import { inspectPromptFragment } from '../../gateway/prompt-boundary.js';
import { searchExactMemory, type ExactSearchOutput } from '../../infra/memory/exact-search.js';

export type MemphisSearchInput = {
  query: string;
  limit?: number;
  chain?: string;
};

export type MemphisSearchOutput = {
  results: ExactSearchOutput['hits'];
  warning?: string;
};

export type SearchDeps = {
  search: typeof searchExactMemory;
};

export function runMemphisSearch(
  input: MemphisSearchInput,
  deps: SearchDeps = { search: searchExactMemory },
): MemphisSearchOutput {
  const out = deps.search(input.query, input.limit ?? 5, undefined, input.chain);
  const safeHits = [];
  let dropped = 0;
  for (const hit of out.hits) {
    const assessment = inspectPromptFragment(
      `${hit.content}\n${hit.summary}\n${hit.snippet}`,
      'recalled_memory',
    );
    if (assessment.allowed) {
      safeHits.push(hit);
    } else {
      dropped += 1;
    }
  }
  return {
    results: safeHits,
    warning:
      dropped > 0
        ? `${dropped} unsafe search hit${dropped === 1 ? '' : 's'} filtered`
        : undefined,
  };
}
