import { embedSearch } from '../../infra/storage/rust-embed-adapter.js';

export type MemphisRecallInput = {
  query: string;
  limit?: number;
};

export type MemphisRecallOutput = {
  results: Array<{ content: string; score: number; tags: string[] }>;
};

export type RecallDeps = {
  search: typeof embedSearch;
};

export function runMemphisRecall(
  input: MemphisRecallInput,
  deps: RecallDeps = { search: embedSearch },
): MemphisRecallOutput {
  const out = deps.search(input.query, input.limit ?? 5);

  return {
    results: out.hits.map((hit) => ({
      content: hit.text_preview,
      score: hit.score,
      tags: [],
    })),
  };
}
