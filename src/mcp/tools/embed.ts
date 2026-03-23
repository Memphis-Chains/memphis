import {
  embedSearch,
  embedStore,
  type EmbedSearchHit,
} from '../../infra/storage/rust-embed-adapter.js';

export interface EmbedStoreInput {
  id: string;
  text: string;
}

export interface EmbedStoreOutput {
  stored: boolean;
  id: string;
  count?: number;
  dim?: number;
  provider?: string;
  error?: string;
}

export interface EmbedSearchInput {
  query: string;
  topK?: number;
}

export interface EmbedSearchOutput {
  query: string;
  count: number;
  hits: EmbedSearchHit[];
  error?: string;
}

/**
 * Store text in the embedding index under a given ID.
 * Requires Rust bridge — returns a clear error if unavailable.
 */
export function runMemphisEmbedStore(input: EmbedStoreInput): EmbedStoreOutput {
  try {
    const result = embedStore(input.id, input.text);
    return { stored: true, ...result };
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return { stored: false, id: input.id, error: msg };
  }
}

/**
 * Semantic search across the embedding index.
 * Requires Rust bridge — returns a clear error if unavailable.
 */
export function runMemphisEmbedSearch(input: EmbedSearchInput): EmbedSearchOutput {
  try {
    const result = embedSearch(input.query, input.topK ?? 5);
    return result;
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return { query: input.query, count: 0, hits: [], error: msg };
  }
}
