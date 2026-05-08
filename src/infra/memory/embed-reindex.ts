import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { buildDefaultMemoryId, buildEmbedTags } from './durable-memory.js';
import { deriveExactSearchEntry } from './exact-search.js';
import { getChainPath, getReadableChainPaths, normalizeChainName } from '../../config/paths.js';
import { getSearchableChainNames } from '../../memory/chain-catalog.js';
import { embedReset, embedStore } from '../storage/rust-embed-adapter.js';

// Sprint 0.5 G2: searchable chain set pulled from canonical catalog so new
// chains (insights, soul, cases etc.) get indexed without touching this
// file. Previously hard-coded 5 chains here; missed insights and cases and
// collective.
const SEARCHABLE_CHAINS = new Set<string>(getSearchableChainNames());

type RawChainBlock = {
  index: number;
  hash: string;
  data: Record<string, unknown>;
};

export type DerivedEmbeddingRebuildResult = {
  chains: string[];
  total: number;
  indexed: number;
  skipped: number;
  cleared: boolean;
};

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
          .filter((chain) => SEARCHABLE_CHAINS.has(chain)),
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
        results.push(block);
      }
    } catch {
      // Ignore unreadable alias directories and keep scanning readable chain paths.
    }
  }

  return results.sort((left, right) => left.index - right.index);
}

export function rebuildDerivedEmbeddings(
  options: { chain?: string; reset?: boolean } = {},
  rawEnv: NodeJS.ProcessEnv = process.env,
): DerivedEmbeddingRebuildResult {
  const chains = collectSearchableChains(rawEnv, options.chain);
  const shouldReset = options.reset !== false;
  let total = 0;
  let indexed = 0;
  let skipped = 0;
  // Per-block embed failures (e.g. Ollama 500 on a particular content
  // shape) used to abort the whole rebuild — repair runtime would just
  // report `embed_store_failed: ollama 500` and 0 vectors land. Keep
  // going block-by-block so a single bad block doesn't keep the entire
  // chain corpus un-indexed. Cap detail logging so a chain-wide outage
  // doesn't flood logs.
  const MAX_FAILURE_DETAIL_LOGS = 5;
  const failureSamples: string[] = [];

  if (shouldReset) {
    embedReset(rawEnv);
  }

  for (const chain of chains) {
    for (const block of readChainBlocks(chain, rawEnv)) {
      total += 1;

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

      const rawMemoryId =
        typeof block.data.memory_id === 'string' && block.data.memory_id.trim().length > 0
          ? block.data.memory_id.trim()
          : undefined;
      const memoryId = rawMemoryId ?? buildDefaultMemoryId(chain, block.index);
      try {
        embedStore(memoryId, entry.content, rawEnv, buildEmbedTags(chain, entry.tags));
        indexed += 1;
      } catch (err) {
        skipped += 1;
        if (failureSamples.length < MAX_FAILURE_DETAIL_LOGS) {
          const msg = err instanceof Error ? err.message : String(err);
          const preview = entry.content.slice(0, 120).replace(/\s+/g, ' ');
          failureSamples.push(
            `chain=${chain} index=${block.index} preview="${preview}" err=${msg.slice(0, 200)}`,
          );
        }
      }
    }
  }

  if (failureSamples.length > 0) {
    // Surface a few samples to aid debugging without spamming. Operators
    // running `memphis repair runtime --rebuild-embeddings` can grep.
    process.stderr.write(
      `[embed-reindex] ${skipped} block(s) skipped due to embed errors; first ${failureSamples.length}:\n` +
        failureSamples.map((s) => `  ${s}`).join('\n') +
        '\n',
    );
  }

  return { chains, total, indexed, skipped, cleared: shouldReset };
}
