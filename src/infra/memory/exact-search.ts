import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  getChainPath,
  getReadableChainPaths,
  normalizeChainName,
} from '../../config/paths.js';
import { buildDecisionContent, normalizeDecisionBlockData } from '../../core/decision-chain.js';
import { createSqliteClient, runMigrations } from '../storage/sqlite/client.js';
import {
  SqliteMemorySearchRepository,
  type ExactSearchHit,
  type ExactSearchIndexEntryInput,
} from '../storage/sqlite/repositories/memory-search-repository.js';

const SEARCHABLE_CHAINS = new Set(['journal', 'decisions', 'patterns', 'reflections', 'proactive']);
const DEFAULT_DATABASE_URL = 'file:./data/memphis.db';

type RawChainBlock = {
  index: number;
  hash: string;
  data: Record<string, unknown>;
};

export type ExactSearchOutput = {
  query: string;
  count: number;
  hits: ExactSearchHit[];
};

export type ExactSearchRebuildResult = {
  indexed: number;
  skipped: number;
  total: number;
  chains: string[];
};

function normalizeSearchTerms(query: string): string[] {
  return query
    .toLowerCase()
    .split(/[^\p{L}\p{N}_-]+/u)
    .map((term) => term.trim())
    .filter((term) => term.length >= 2);
}

function getDatabaseUrl(rawEnv: NodeJS.ProcessEnv = process.env): string {
  return rawEnv.DATABASE_URL?.trim() || DEFAULT_DATABASE_URL;
}

function normalizeTags(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((tag): tag is string => typeof tag === 'string' && tag.trim().length > 0)
    : [];
}

function summarizeContent(content: string): string {
  const collapsed = content.replace(/\s+/g, ' ').trim();
  return collapsed.length <= 160 ? collapsed : `${collapsed.slice(0, 157)}...`;
}

function hasAllTags(actualTags: string[], requestedTags?: string[]): boolean {
  if (!requestedTags || requestedTags.length === 0) return true;
  const available = new Set(actualTags.map((tag) => tag.toLowerCase()));
  return requestedTags.every((tag) => available.has(tag.toLowerCase()));
}

function scoreDerivedEntry(query: string, terms: string[], entry: ExactSearchIndexEntryInput): number {
  const haystack = `${entry.content}\n${entry.summary}\n${entry.tags.join(' ')}`
    .toLowerCase()
    .trim();
  if (!haystack) return 0;

  let score = 0;
  if (haystack.includes(query)) {
    score += 0.6;
  }

  for (const term of terms) {
    if (!haystack.includes(term)) continue;
    score += 0.12;
    if (entry.tags.some((tag) => tag.toLowerCase().includes(term))) {
      score += 0.08;
    }
    const title = typeof entry.metadata?.title === 'string' ? entry.metadata.title.toLowerCase() : '';
    if (title.includes(term)) {
      score += 0.1;
    }
  }

  return Number(Math.min(score, 0.99).toFixed(6));
}

export function deriveExactSearchEntry(input: {
  chain: string;
  index: number;
  hash: string;
  data: Record<string, unknown>;
}): ExactSearchIndexEntryInput | null {
  const chain = normalizeChainName(input.chain) ?? input.chain;
  if (!SEARCHABLE_CHAINS.has(chain)) {
    return null;
  }

  const data =
    chain === 'decisions' ? normalizeDecisionBlockData(input.data) : input.data;
  const tags = normalizeTags(data.tags);

  if (chain === 'decisions') {
    const content = buildDecisionContent(data);
    if (!content) {
      return null;
    }

    return {
      sourceKey: `${chain}:${input.index}`,
      chain,
      blockIndex: input.index,
      blockHash: input.hash,
      blockType: 'decision',
      content,
      summary: summarizeContent(content),
      tags: tags.length > 0 ? tags : ['decision'],
      metadata: {
        title: typeof data.title === 'string' ? data.title : undefined,
        choice: typeof data.choice === 'string' ? data.choice : undefined,
        context: typeof data.context === 'string' ? data.context : undefined,
      },
    };
  }

  const content = typeof data.content === 'string' ? data.content.trim() : '';
  if (!content) {
    return null;
  }

  const blockType =
    typeof data.type === 'string' && data.type.trim().length > 0
      ? data.type.trim()
      : chain === 'journal'
        ? 'journal'
        : 'insight';

  return {
    sourceKey: `${chain}:${input.index}`,
    chain,
    blockIndex: input.index,
    blockHash: input.hash,
    blockType,
    content,
    summary: summarizeContent(content),
    tags,
    metadata: {
      kind: typeof data.kind === 'string' ? data.kind : undefined,
      source: typeof data.source === 'string' ? data.source : undefined,
    },
  };
}

function withMemorySearchRepository<T>(
  rawEnv: NodeJS.ProcessEnv,
  fn: (repo: SqliteMemorySearchRepository) => T,
): T {
  const db = createSqliteClient(getDatabaseUrl(rawEnv));
  try {
    runMigrations(db);
    return fn(new SqliteMemorySearchRepository(db));
  } finally {
    db.close();
  }
}

export function indexExactSearchBlock(
  input: {
    chain: string;
    index: number;
    hash: string;
    data: Record<string, unknown>;
  },
  rawEnv: NodeJS.ProcessEnv = process.env,
): boolean {
  const entry = deriveExactSearchEntry(input);
  if (!entry) {
    return false;
  }

  withMemorySearchRepository(rawEnv, (repo) => repo.upsert(entry));
  return true;
}

export function searchExactMemory(
  query: string,
  limit = 5,
  rawEnv: NodeJS.ProcessEnv = process.env,
  chain?: string,
): ExactSearchOutput {
  const trimmed = query.trim();
  if (!trimmed) {
    return { query: trimmed, count: 0, hits: [] };
  }

  return withMemorySearchRepository(rawEnv, (repo) => {
    if (repo.count() === 0) {
      populateRepositoryFromChains(repo, rawEnv);
    }
    const hits = repo.search(trimmed, limit, normalizeChainName(chain));
    return {
      query: trimmed,
      count: hits.length,
      hits,
    };
  });
}

export function searchChainsDirectly(
  query: string,
  limit = 5,
  rawEnv: NodeJS.ProcessEnv = process.env,
  chain?: string,
  tags?: string[],
): ExactSearchOutput {
  const trimmed = query.trim();
  if (!trimmed) {
    return { query: trimmed, count: 0, hits: [] };
  }

  const terms = normalizeSearchTerms(trimmed);
  const hits: ExactSearchHit[] = [];
  const safeLimit = Math.max(1, Math.min(limit, 100));
  const indexedAt = new Date().toISOString();

  for (const chainName of collectSearchableChains(rawEnv, chain)) {
    for (const block of readChainBlocks(chainName, rawEnv)) {
      const entry = deriveExactSearchEntry({
        chain: chainName,
        index: block.index,
        hash: block.hash,
        data: block.data,
      });
      if (!entry || !hasAllTags(entry.tags, tags)) {
        continue;
      }

      const score = scoreDerivedEntry(trimmed.toLowerCase(), terms, entry);
      if (score <= 0) {
        continue;
      }

      hits.push({
        sourceKey: entry.sourceKey,
        chain: entry.chain,
        blockIndex: entry.blockIndex,
        blockHash: entry.blockHash,
        blockType: entry.blockType,
        content: entry.content,
        summary: entry.summary,
        snippet: entry.summary,
        tags: entry.tags,
        metadata: entry.metadata ?? {},
        score,
        indexedAt,
      });
    }
  }

  const ranked = hits
    .sort((left, right) => right.score - left.score || right.blockIndex - left.blockIndex)
    .slice(0, safeLimit);

  return {
    query: trimmed,
    count: ranked.length,
    hits: ranked,
  };
}

function collectSearchableChains(rawEnv: NodeJS.ProcessEnv, requestedChain?: string): string[] {
  if (requestedChain) {
    const normalized = normalizeChainName(requestedChain);
    return normalized && SEARCHABLE_CHAINS.has(normalized) ? [normalized] : [];
  }

  try {
    return Array.from(
      new Set(
        readdirSync(getChainPath(undefined, rawEnv), { withFileTypes: true })
          .filter((entry) => entry.isDirectory())
          .map((entry) => normalizeChainName(entry.name) ?? entry.name)
          .filter((name) => SEARCHABLE_CHAINS.has(name)),
      ),
    ).sort();
  } catch {
    return [];
  }
}

function readChainBlocks(chain: string, rawEnv: NodeJS.ProcessEnv): RawChainBlock[] {
  const results: RawChainBlock[] = [];
  const seen = new Set<string>();

  for (const dir of getReadableChainPaths(chain, rawEnv)) {
    try {
      for (const file of readdirSync(dir).filter((entry) => /^\d+\.json$/.test(entry)).sort()) {
        const block = JSON.parse(readFileSync(join(dir, file), 'utf8')) as RawChainBlock;
        const key = `${block.hash}:${block.index}`;
        if (seen.has(key)) continue;
        seen.add(key);
        results.push({
          ...block,
          data:
            chain === 'decisions' && block.data
              ? normalizeDecisionBlockData(block.data)
              : block.data,
        });
      }
    } catch {
      // ignore missing alias directories
    }
  }

  return results.sort((a, b) => a.index - b.index);
}

function populateRepositoryFromChains(
  repo: SqliteMemorySearchRepository,
  rawEnv: NodeJS.ProcessEnv,
  options: { chain?: string } = {},
): ExactSearchRebuildResult {
  const chains = collectSearchableChains(rawEnv, options.chain);
  let indexed = 0;
  let skipped = 0;
  let total = 0;

  for (const chain of chains) {
    const blocks = readChainBlocks(chain, rawEnv);
    total += blocks.length;

    for (const block of blocks) {
      const entry = deriveExactSearchEntry({
        chain,
        index: block.index,
        hash: block.hash,
        data: block.data,
      });
      if (!entry) {
        skipped += 1;
        continue;
      }
      repo.upsert(entry);
      indexed += 1;
    }
  }

  return { indexed, skipped, total, chains };
}

export function rebuildExactSearchIndex(
  options: { chain?: string } = {},
  rawEnv: NodeJS.ProcessEnv = process.env,
): ExactSearchRebuildResult {
  return withMemorySearchRepository(rawEnv, (repo) => {
    repo.clear();
    return populateRepositoryFromChains(repo, rawEnv, options);
  });
}
