// TypeScript fallback search implementation

export interface SearchResult {
  id: string;
  content: string;
  score: number;
  timestamp: string;
  warning?: string;
  results?: SearchResult[];
}

export async function searchChainTS(
  _query: string,
): Promise<{ results: SearchResult[]; warning: string }> {
  // TODO: implement real TypeScript chain search over local JSONL files
  // Currently returns empty results to avoid misleading callers with fake data
  return {
    results: [],
    warning: 'TypeScript chain search not implemented — returning empty results',
  };
}
