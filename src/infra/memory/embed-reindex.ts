import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { buildDefaultMemoryId, buildEmbedTags } from './durable-memory.js';
import { deriveExactSearchEntry } from './exact-search.js';
import { getChainPath, getReadableChainPaths, normalizeChainName } from '../../config/paths.js';
import { embedReset, embedStore } from '../storage/rust-embed-adapter.js';

const SEARCHABLE_CHAINS = new Set(['journal', 'decisions', 'patterns', 'reflections', 'proactive']);

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
      embedStore(memoryId, entry.content, rawEnv, buildEmbedTags(chain, entry.tags));
      indexed += 1;
    }
  }

  return { chains, total, indexed, skipped, cleared: shouldReset };
}
