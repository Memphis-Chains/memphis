import {
  searchChainsDirectly,
  searchExactMemory,
} from '../../infra/memory/exact-search.js';
import { embedSearch, type EmbedSearchHit } from '../../infra/storage/rust-embed-adapter.js';
import type { ExactSearchHit } from '../../infra/storage/sqlite/repositories/memory-search-repository.js';

export type MemphisRecallInput = {
  query: string;
  limit?: number;
  tags?: string[];
  chain?: string;
};

export type RecallMode = 'semantic' | 'exact' | 'chain' | 'none';

export type MemphisRecallOutput = {
  mode: RecallMode;
  degraded: boolean;
  warning?: string;
  results: Array<{ content: string; score: number; tags: string[]; chain?: string; sourceKey?: string }>;
};

export type RecallDeps = {
  search?: typeof embedSearch;
  exactSearch?: typeof searchExactMemory;
  chainSearch?: typeof searchChainsDirectly;
  rawEnv?: NodeJS.ProcessEnv;
};

function normalizeLimit(limit: number | undefined): number {
  if (!Number.isFinite(limit) || (limit ?? 0) <= 0) return 5;
  return Math.max(1, Math.min(Math.trunc(limit ?? 5), 100));
}

function normalizeTags(tags?: string[]): string[] | undefined {
  const filtered = tags?.filter((tag): tag is string => typeof tag === 'string' && tag.trim().length > 0);
  return filtered && filtered.length > 0 ? filtered : undefined;
}

function getChainTag(tags: string[] | undefined): string | undefined {
  return tags?.find((tag) => tag.startsWith('chain:'))?.slice('chain:'.length) || undefined;
}

function semanticSearchTags(tags: string[] | undefined, chain?: string): string[] | undefined {
  const merged = [...(tags ?? [])];
  if (chain) {
    merged.push(`chain:${chain}`);
  }
  return merged.length > 0 ? Array.from(new Set(merged)) : undefined;
}

function mapSemanticHits(hits: EmbedSearchHit[]): MemphisRecallOutput['results'] {
  return hits.map((hit) => ({
    content: hit.text_preview,
    score: hit.score,
    tags: hit.tags ?? [],
    chain: getChainTag(hit.tags),
    sourceKey: hit.id,
  }));
}

function mapExactHits(hits: ExactSearchHit[]): MemphisRecallOutput['results'] {
  return hits.map((hit) => ({
    content: hit.content,
    score: hit.score,
    tags: hit.tags ?? [],
    chain: hit.chain,
    sourceKey: hit.sourceKey,
  }));
}

function filterByTags(
  hits: MemphisRecallOutput['results'],
  tags?: string[],
): MemphisRecallOutput['results'] {
  if (!tags || tags.length === 0) return hits;
  const requested = new Set(tags.map((tag) => tag.toLowerCase()));
  return hits.filter((hit) => {
    const available = new Set((hit.tags ?? []).map((tag) => tag.toLowerCase()));
    return Array.from(requested).every((tag) => available.has(tag));
  });
}

function finalizeRecall(
  mode: RecallMode,
  hits: MemphisRecallOutput['results'],
  warnings: string[],
): MemphisRecallOutput {
  return {
    mode,
    degraded: warnings.length > 0 && mode !== 'semantic',
    warning: warnings.length > 0 ? warnings.join('; ') : undefined,
    results: hits,
  };
}

export function runMemphisRecall(
  input: MemphisRecallInput,
  deps: RecallDeps = { search: embedSearch, exactSearch: searchExactMemory, chainSearch: searchChainsDirectly },
): MemphisRecallOutput {
  const limit = normalizeLimit(input.limit);
  const rawEnv = deps.rawEnv;
  const tags = normalizeTags(input.tags);
  const warnings: string[] = [];

  try {
    const out = (deps.search ?? embedSearch)(
      input.query,
      limit,
      rawEnv,
      semanticSearchTags(tags, input.chain),
    );
    const semanticHits = mapSemanticHits(out.hits)
      .filter((hit) => !input.chain || hit.chain === input.chain)
      .slice(0, limit);
    if (semanticHits.length > 0) {
      return finalizeRecall('semantic', semanticHits, warnings);
    }
  } catch (error) {
    warnings.push(error instanceof Error ? error.message : String(error));
  }

  try {
    const out = (deps.exactSearch ?? searchExactMemory)(
      input.query,
      Math.min(limit * 3, 100),
      rawEnv,
      input.chain,
    );
    const exactHits = filterByTags(mapExactHits(out.hits), tags).slice(0, limit);
    if (exactHits.length > 0) {
      return finalizeRecall('exact', exactHits, warnings);
    }
  } catch (error) {
    warnings.push(error instanceof Error ? error.message : String(error));
  }

  try {
    const out = (deps.chainSearch ?? searchChainsDirectly)(
      input.query,
      Math.min(limit * 3, 100),
      rawEnv,
      input.chain,
      tags,
    );
    const chainHits = mapExactHits(out.hits).slice(0, limit);
    return finalizeRecall(chainHits.length > 0 ? 'chain' : 'none', chainHits, warnings);
  } catch (error) {
    warnings.push(error instanceof Error ? error.message : String(error));
  }

  return finalizeRecall('none', [], warnings);
}
