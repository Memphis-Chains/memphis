import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { getChainPath } from '../../config/paths.js';
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

function buildDecisionContent(data: Record<string, unknown>): string | null {
  const title = typeof data.title === 'string' ? data.title.trim() : '';
  const choice = typeof data.choice === 'string' ? data.choice.trim() : '';
  const context = typeof data.context === 'string' ? data.context.trim() : '';

  if (!title && !choice && !context) {
    return null;
  }

  const lines = [
    title ? `Decision: ${title}` : '',
    choice ? `Choice: ${choice}` : '',
    context ? `Context: ${context}` : '',
  ].filter(Boolean);

  return lines.join('\n');
}

export function deriveExactSearchEntry(input: {
  chain: string;
  index: number;
  hash: string;
  data: Record<string, unknown>;
}): ExactSearchIndexEntryInput | null {
  if (!SEARCHABLE_CHAINS.has(input.chain)) {
    return null;
  }

  const data = input.data;
  const tags = normalizeTags(data.tags);

  if (input.chain === 'decisions') {
    const content = buildDecisionContent(data);
    if (!content) {
      return null;
    }

    return {
      sourceKey: `${input.chain}:${input.index}`,
      chain: input.chain,
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
      : input.chain === 'journal'
        ? 'journal'
        : 'insight';

  return {
    sourceKey: `${input.chain}:${input.index}`,
    chain: input.chain,
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
    const hits = repo.search(trimmed, limit, chain);
    return {
      query: trimmed,
      count: hits.length,
      hits,
    };
  });
}

function collectSearchableChains(rawEnv: NodeJS.ProcessEnv, requestedChain?: string): string[] {
  if (requestedChain) {
    return SEARCHABLE_CHAINS.has(requestedChain) ? [requestedChain] : [];
  }

  try {
    return readdirSync(getChainPath(undefined, rawEnv), { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && SEARCHABLE_CHAINS.has(entry.name))
      .map((entry) => entry.name)
      .sort();
  } catch {
    return [];
  }
}

function readChainBlocks(chain: string, rawEnv: NodeJS.ProcessEnv): RawChainBlock[] {
  try {
    return readdirSync(getChainPath(chain, rawEnv))
      .filter((file) => /^\d+\.json$/.test(file))
      .sort()
      .map((file) => JSON.parse(readFileSync(join(getChainPath(chain, rawEnv), file), 'utf8')) as RawChainBlock);
  } catch {
    return [];
  }
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
