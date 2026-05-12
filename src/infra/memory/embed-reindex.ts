import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { buildDefaultMemoryId, buildEmbedTags } from './durable-memory.js';
import { deriveExactSearchEntry } from './exact-search.js';
import { getChainPath, getReadableChainPaths, normalizeChainName } from '../../config/paths.js';
import { getSearchableChainNames } from '../../memory/chain-catalog.js';
import {
  embedFlush,
  embedReset,
  embedStore,
  embedStoreMany,
  isEmbedBulkAvailable,
  type EmbedStoreItem,
} from '../storage/rust-embed-adapter.js';

// Chunk size for the bulk path. Picked to amortize the per-call NAPI
// envelope+lock overhead (which is per-call, not per-item) without
// bloating any single envelope payload past serde_json's comfort zone
// for ~1KB-text-per-doc corpora.
const BULK_CHUNK_SIZE = 256;

/**
 * Truncate `text` so its UTF-8 byte length is at most `maxBytes`. Used
 * before forwarding text to the Rust embed pipeline, which rejects
 * inputs above `DEFAULT_MAX_TEXT_BYTES = 4096` outright. Returns the
 * original string when it already fits.
 *
 * Important: counts UTF-8 *bytes*, not JS-side UTF-16 code units. The
 * naive `text.slice(0, 4000)` would still let multi-byte characters
 * (Polish ą/ę/ó etc., or emoji) overflow the byte budget — Codex review
 * #585 specifically called this out for operator-language inputs.
 *
 * When truncation happens, append a small marker so the LLM consumer
 * can tell content was clipped (rare but real — operator's daily
 * insight blocks hit 8-10 KB).
 */
export function truncateUtf8(text: string, maxBytes: number): string {
  const encoded = Buffer.from(text, 'utf8');
  if (encoded.length <= maxBytes) return text;
  // Walk back from `maxBytes` to the nearest UTF-8 boundary so we don't
  // split a multi-byte codepoint. Continuation bytes are 0b10xxxxxx
  // (range 0x80..=0xBF) — keep stepping while we see one.
  let cut = maxBytes;
  while (cut > 0 && (encoded[cut] ?? 0) >= 0x80 && (encoded[cut] ?? 0) < 0xc0) {
    cut -= 1;
  }
  return encoded.subarray(0, cut).toString('utf8') + '\n[truncated for embed]';
}

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

interface PreparedEmbedItem {
  chain: string;
  index: number;
  item: EmbedStoreItem;
}

export function rebuildDerivedEmbeddings(
  options: { chain?: string; reset?: boolean } = {},
  rawEnv: NodeJS.ProcessEnv = process.env,
): DerivedEmbeddingRebuildResult {
  const chains = collectSearchableChains(rawEnv, options.chain);
  const shouldReset = options.reset !== false;
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

  // 1. Walk all chains, derive the exact-search entry per block, and
  //    prepare the embed items. `total` counts blocks examined; `skipped`
  //    counts blocks that produced no entry (chain-catalog miss, empty
  //    data, etc.) BEFORE we hit the embed pipeline.
  let total = 0;
  let skipped = 0;
  const prepared: PreparedEmbedItem[] = [];

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
      // Rust embed pipeline rejects text whose UTF-8 byte length exceeds
      // `DEFAULT_MAX_TEXT_BYTES = 4096` (crates/memphis-embed/src/pipeline.rs:64).
      // Live observation 2026-05-12: 38 insight blocks (8-10 KB JSON
      // dumps from the daily reflection loop) silently rejected with
      // `embed_store_failed: text too large`. Truncate at the byte
      // boundary, NOT at JavaScript char count — Codex review #585
      // caught that `.length` and `.slice()` count UTF-16 code units,
      // so Polish-heavy text could still exceed 4096 UTF-8 bytes after
      // a 4000-char slice.
      const embedText = truncateUtf8(entry.content, 4000);
      prepared.push({
        chain,
        index: block.index,
        item: {
          id: memoryId,
          text: embedText,
          tags: buildEmbedTags(chain, entry.tags),
        },
      });
    }
  }

  // 2. Index. Prefer the bulk + flush path — it amortizes per-item
  //    persistence into one disk write at the end (a 6326-block rebuild
  //    historically wrote ~290 GB through the per-item path; bulk
  //    completes in seconds). Fall back to per-item if the loaded NAPI
  //    binary predates the bulk surface.
  let indexed = 0;

  const recordFailure = (chain: string, index: number, content: string, err: unknown) => {
    skipped += 1;
    if (failureSamples.length < MAX_FAILURE_DETAIL_LOGS) {
      const msg = err instanceof Error ? err.message : String(err);
      const preview = content.slice(0, 120).replace(/\s+/g, ' ');
      failureSamples.push(
        `chain=${chain} index=${index} preview="${preview}" err=${msg.slice(0, 200)}`,
      );
    }
  };

  if (isEmbedBulkAvailable(rawEnv) && prepared.length > 0) {
    for (let i = 0; i < prepared.length; i += BULK_CHUNK_SIZE) {
      const window = prepared.slice(i, i + BULK_CHUNK_SIZE);
      try {
        const result = embedStoreMany(
          window.map((p) => p.item),
          rawEnv,
        );
        indexed += result.inserted;
      } catch (chunkErr) {
        // Bulk failed mid-chunk — fall back to per-item for THIS chunk
        // only so a single bad block doesn't poison the rebuild.
        for (const prep of window) {
          try {
            embedStore(prep.item.id, prep.item.text, rawEnv, prep.item.tags);
            indexed += 1;
          } catch (singleErr) {
            recordFailure(prep.chain, prep.index, prep.item.text, singleErr);
          }
        }
        // Note the chunk-level error in the sample log too — useful when
        // the cause is structural (provider 500 on every block) rather
        // than per-block.
        if (failureSamples.length < MAX_FAILURE_DETAIL_LOGS) {
          const msg = chunkErr instanceof Error ? chunkErr.message : String(chunkErr);
          failureSamples.push(
            `chunk_failed offset=${i} size=${window.length} err=${msg.slice(0, 200)}`,
          );
        }
      }
    }

    // Single materializing flush at the end — this is the writes-to-disk
    // moment.
    try {
      embedFlush(rawEnv);
    } catch (flushErr) {
      const msg = flushErr instanceof Error ? flushErr.message : String(flushErr);
      process.stderr.write(`[embed-reindex] flush failed: ${msg}\n`);
      // Don't throw — we still want the caller to see the indexed/skipped
      // counts; the flush failure is surfaced via stderr.
    }
  } else {
    // Legacy per-item path (older NAPI binary, or empty corpus).
    for (const prep of prepared) {
      try {
        embedStore(prep.item.id, prep.item.text, rawEnv, prep.item.tags);
        indexed += 1;
      } catch (err) {
        recordFailure(prep.chain, prep.index, prep.item.text, err);
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
