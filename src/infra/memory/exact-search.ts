import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { getChainPath, getReadableChainPaths, normalizeChainName } from '../../config/paths.js';
import { buildDecisionContent, normalizeDecisionBlockData } from '../../core/decision-chain.js';
import { getSearchableChainNames } from '../../memory/chain-catalog.js';
import {
  ARCHIVES_DIR_NAME,
  parseArchiveFileName,
  readArchiveBlocksSync,
  type ArchiveBlockValue,
  type ArchiveFileName,
} from '../storage/chain-archive-format.js';
import { createSqliteClient, runMigrations } from '../storage/sqlite/client.js';
import {
  SqliteMemorySearchRepository,
  type ExactSearchHit,
  type ExactSearchIndexEntryInput,
} from '../storage/sqlite/repositories/memory-search-repository.js';

// Sprint 0.5 G2: pull searchable-chain set from canonical catalog so new
// chains don't silently drop out of exact-search coverage.
const SEARCHABLE_CHAINS = new Set<string>(getSearchableChainNames());
const DEFAULT_DATABASE_URL = 'file:./data/memphis.db';

type RawChainBlock = {
  index: number;
  hash: string;
  data: Record<string, unknown>;
};

export type RecallSourceReference = { memoryId: string; chain?: string };

/** Resolve vector hits to durable content without using their shortened previews.
 * Read each requested chain once. IDs are compared as data, never used as paths.
 */
export function resolveRecallSources(
  references: RecallSourceReference[],
  rawEnv: NodeJS.ProcessEnv = process.env,
): Map<string, ExactSearchIndexEntryInput> {
  const wanted = new Set(references.map((ref) => `${ref.chain ?? ''}:${ref.memoryId}`));
  const chains = new Set(
    references
      .map((ref) => normalizeChainName(ref.chain))
      .filter((chain): chain is string => Boolean(chain && SEARCHABLE_CHAINS.has(chain))),
  );
  const resolved = new Map<string, ExactSearchIndexEntryInput>();
  for (const chain of chains) {
    for (const block of readChainBlocks(chain, rawEnv)) {
      collectSource(chain, block, wanted, resolved);
    }
    // The blocks the rotation moved aside are still the operator's memory.
    resolveArchivedSources(chain, wanted, resolved, rawEnv);
  }
  return resolved;
}

/**
 * Match one block against the wanted memory ids and remember its entry.
 *
 * One rule for a block's identity, used by the live chain and by the
 * rotation archives alike: the memory id is the block's own
 * `data.memory_id` when it has one, and `{chain}-{index}` otherwise.
 */
function collectSource(
  chain: string,
  block: RawChainBlock,
  wanted: Set<string>,
  resolved: Map<string, ExactSearchIndexEntryInput>,
): void {
  const defaultId = `${chain}-${block.index}`;
  const memoryId =
    typeof block.data.memory_id === 'string' && block.data.memory_id.trim()
      ? block.data.memory_id.trim()
      : defaultId;
  const keys = [`${chain}:${memoryId}`, `${chain}:${defaultId}`].filter((key) => wanted.has(key));
  if (keys.length === 0) return;
  const entry = deriveExactSearchEntry({
    chain,
    index: block.index,
    hash: block.hash,
    data: block.data,
  });
  if (entry) for (const key of keys) resolved.set(key, entry);
}

/**
 * Resolve the blocks the chain rotation moved into an archive.
 *
 * ## Why this exists
 *
 * The rotation bounds a chain on disk: it moves the old prefix into
 * `<chains>/.archives/<chain>_<from>-<to>_<timestamp>.jsonl.gz` and keeps
 * the tail live. The blocks are NOT deleted — the archive restores them,
 * whole, with `memphis chain restore`.
 *
 * But the semantic index is not the chain: it holds the CHUNKS of every
 * block that was ever indexed, and its chunk ids point at
 * `{chain}-{index}`. Nothing told the index that half the chain moved,
 * so the recall kept finding those chunks — and could not find the
 * blocks behind them, because they are no longer in the live directory.
 *
 * The recall degraded silently: instead of the block's content it
 * returned the chunk's shortened preview, and said so with
 * `contentSource: "preview"`.
 *
 * > Measured 2026-11-23 on this host, on the real rotation of the
 * > `insights` chain (297 blocks archived): 2 761 of 12 942 chunks in the
 * > live embed index point at blocks that are no longer on disk — 21.3 %
 * > of the index — and 192 of 196 recall hits on archived blocks came
 * > back as an 81-character preview instead of the content.
 *
 * ## Why the reader, and not the index
 *
 * The obvious fix is to purge the archived chunks from the index when the
 * rotation happens. That would DELETE the operator's semantic memory of
 * 297 blocks — the distilled insights — from every future search, and it
 * would do so silently, in a feature whose whole purpose is to move
 * history aside without losing it.
 *
 * The blocks are still there. The reader is what was missing them, so the
 * reader is what has to learn where they went.
 *
 * ## What it costs
 *
 * An archive is opened only when a wanted block was NOT found live, and
 * only when its index range can hold a wanted index. Measured on this
 * host: the `insights` archive (297 blocks) reads in ~380 ms — gunzip,
 * scan, parse — and the `system` archive (15 271 blocks) in ~260 ms.
 */
function resolveArchivedSources(
  chain: string,
  wanted: Set<string>,
  resolved: Map<string, ExactSearchIndexEntryInput>,
  rawEnv: NodeJS.ProcessEnv,
): void {
  const missing = [...wanted].filter((key) => !resolved.has(key));
  if (missing.length === 0) return;

  const archiveDir = join(dirname(getChainPath(chain, rawEnv)), ARCHIVES_DIR_NAME);
  let entries: string[];
  try {
    entries = readdirSync(archiveDir);
  } catch {
    return; // no archives for this chain
  }

  const archives = entries
    .map((file) => ({ file, name: parseArchiveFileName(file) }))
    .filter((entry): entry is { file: string; name: ArchiveFileName } => entry.name !== null)
    .filter((entry) => entry.name.chain === chain)
    // Newest first: the most recent archive holds the most recent prefix.
    .sort((a, b) => b.name.timestamp.localeCompare(a.name.timestamp));
  if (archives.length === 0) return;

  // Which block indexes are wanted? A memory id is usually
  // `{chain}-{index}`, and the archive's NAME carries the index range — so
  // an archive that cannot hold a wanted index is never opened.
  const wantedIndexes = new Set<number>();
  let hasUnindexedId = false;
  for (const key of missing) {
    const memoryId = key.slice(key.indexOf(':') + 1);
    const match = /^(.+)-(\d+)$/.exec(memoryId);
    if (match) wantedIndexes.add(Number(match[2]));
    else hasUnindexedId = true;
  }

  for (const archive of archives) {
    if (!hasUnindexedId) {
      let covered = false;
      for (const index of wantedIndexes) {
        if (index >= archive.name.firstIndex && index <= archive.name.lastIndex) {
          covered = true;
          break;
        }
      }
      if (!covered) continue;
    }

    let blocks: ArchiveBlockValue[];
    try {
      blocks = readArchiveBlocksSync(join(archiveDir, archive.file));
    } catch {
      continue; // an unreadable archive must not break the recall
    }

    for (const block of blocks) {
      const index = typeof block.index === 'number' ? block.index : -1;
      const hash = typeof block.hash === 'string' ? block.hash : '';
      const data = (block.data ?? {}) as Record<string, unknown>;
      collectSource(chain, { index, hash, data }, wanted, resolved);
    }
  }
}

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

function scoreDerivedEntry(
  query: string,
  terms: string[],
  entry: ExactSearchIndexEntryInput,
): number {
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
    const title =
      typeof entry.metadata?.title === 'string' ? entry.metadata.title.toLowerCase() : '';
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

  const data = chain === 'decisions' ? normalizeDecisionBlockData(input.data) : input.data;
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
      for (const file of readdirSync(dir)
        .filter((entry) => /^\d+\.json$/.test(entry))
        .sort()) {
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
