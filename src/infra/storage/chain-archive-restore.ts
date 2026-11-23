/**
 * Archive decompression for chain restore (closes deferred item #6).
 *
 * `chain-rotation.ts` produces gzipped JSONL archives in
 * `data/chains/.archives/` when a chain exceeds the rotation threshold.
 * Until now there was no automated restore path — archived blocks sat
 * on disk indefinitely with no supported way to bring them back into
 * an active chain. This module fills that gap.
 *
 * Restore flow:
 *   1. Gunzip the archive and split it into its JSON values (streamed).
 *      The split is by VALUE, not by line: the reader accepts both true
 *      JSON Lines and the legacy pretty-printed layout that the writer
 *      produced before 2026-11-23. See `chain-archive-format.ts`.
 *   2. Parse each block, recompute its hash, compare to stored hash.
 *      Any mismatch aborts the restore — the archive is corrupt.
 *   3. Validate the prev_hash chain internally (block[i].prev_hash must
 *      equal block[i-1].hash).
 *   4. Compare the archive's first block's prev_hash to the active
 *      chain's last block's hash. If they don't match, the archive is
 *      from a different history — refuse with a clear error.
 *   5. Write each block back to `data/chains/<chain>/NNNNNN.json` in
 *      order, checking for filename collisions (never overwrite).
 *   6. Return a report.
 *
 * Companion to `chain verify` — operators should run `chain verify`
 * post-restore to get the fresh full-chain integrity check.
 */

import { createReadStream } from 'node:fs';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import { createGunzip } from 'node:zlib';

import { hashBlock, type ChainBlock } from './chain-adapter.js';
import { scanArchiveValues } from './chain-archive-format.js';
import { serializeBlockForDisk } from './chain-file-io.js';
import { getChainPath } from '../../config/paths.js';
import { SAFE_CHAIN_NAME } from '../../memory/chain-catalog.js';

export interface ChainArchiveRestoreResult {
  chain: string;
  archivePath: string;
  blocksRead: number;
  blocksRestored: number;
  firstIndex: number | null;
  lastIndex: number | null;
  skippedExisting: number;
}

export interface ChainArchiveRestoreOptions {
  rawEnv?: NodeJS.ProcessEnv;
  /**
   * When true, blocks whose index already exists in the active chain are
   * SKIPPED (not overwritten). Default true — restore is additive-only.
   */
  skipExisting?: boolean;
  /**
   * When true, skip the "archive continues the active chain" check. Use
   * only for disaster-recovery scenarios where you're restoring into an
   * empty chain dir and can't verify continuity.
   */
  allowDiscontinuousRestore?: boolean;
  /** Test seam. */
  crypto?: typeof import('node:crypto');
}

export class ChainArchiveRestoreError extends Error {
  constructor(
    message: string,
    public readonly code:
      | 'invalid-chain-name'
      | 'archive-not-found'
      | 'hash-mismatch'
      | 'internal-chain-break'
      | 'discontinuous-with-active'
      | 'parse-error'
      | 'empty-archive',
  ) {
    super(message);
    this.name = 'ChainArchiveRestoreError';
  }
}

async function readArchiveToBlocks(archivePath: string): Promise<ChainBlock[]> {
  const blocks: ChainBlock[] = [];
  await new Promise<void>((resolve, reject) => {
    const stream = createReadStream(archivePath).pipe(createGunzip());
    // A UTF-8 DECODER, not `chunk.toString('utf8')`.
    //
    // A multi-byte character that straddles a chunk boundary is not a
    // character plus a fragment — it is one character. Decoding each
    // chunk on its own replaces the split sequence with U+FFFD, and the
    // block's content is silently wrong.
    //
    // Measured 2026-11-23 on this host, on a real rotation of the
    // `insights` chain (297 blocks archived): 20 of the 297 lines came
    // back corrupted, the first of them at block 190 — where the restore
    // then failed with "hash mismatch at block 190", because the
    // corrupted byte sat inside a hash-covered field. Every corrupted
    // character sat exactly two bytes before a 16 KB chunk boundary:
    // the two bytes of `ó` (0xC3 0xB3), split in half.
    //
    // `StringDecoder` holds the incomplete tail of a chunk until the
    // next one arrives, so the character survives.
    const decoder = new StringDecoder('utf8');
    let buffer = '';
    stream.on('data', (chunk: Buffer | string) => {
      buffer += typeof chunk === 'string' ? chunk : decoder.write(chunk);

      // Split the stream into complete JSON VALUES, not into lines.
      //
      // The old reader split on newlines and parsed each line — which is
      // what "JSON Lines" means — while the writer produced pretty-printed
      // blocks glued together by newlines. Every archive the runtime
      // produced therefore died on its first line, which was `{`.
      //
      // The scanner reads both the current format (one object per line)
      // and the legacy one (objects spread over many lines), so the
      // archives already on disk stay recoverable. See
      // `chain-archive-format.ts`.
      const scan = scanArchiveValues(buffer);
      buffer = scan.rest;

      for (const value of scan.values) {
        try {
          blocks.push(JSON.parse(value) as ChainBlock);
        } catch (err) {
          reject(
            new ChainArchiveRestoreError(
              `parse error in archive: ${err instanceof Error ? err.message : String(err)}`,
              'parse-error',
            ),
          );
          stream.destroy();
          return;
        }
      }
    });
    stream.on('end', () => {
      // Flush the decoder's tail — a truncated character at the very end
      // of the stream still has to be surfaced, not silently dropped.
      buffer += decoder.end();

      // Anything left is a truncated value — fail closed.
      const tail = buffer.trim();
      if (tail) {
        try {
          blocks.push(JSON.parse(tail) as ChainBlock);
        } catch (err) {
          reject(
            new ChainArchiveRestoreError(
              `parse error at archive tail: ${err instanceof Error ? err.message : String(err)}`,
              'parse-error',
            ),
          );
          return;
        }
      }
      resolve();
    });
    stream.on('error', (err) => {
      reject(err instanceof ChainArchiveRestoreError ? err : err);
    });
  });
  return blocks;
}

/**
 * Codex Round 5 P1 fix: restore is a PREFIX operation. `rotateChain`
 * archives the OLDEST blocks (`blocks.slice(0, blocks.length - minKeep)`),
 * so a valid archive precedes the active chain rather than continuing it.
 *
 * For continuity, the archive's LAST block's hash must equal the active
 * chain's FIRST block's prev_hash. If the active chain is empty or its
 * first block is index 1 (no rotation has happened), no continuity
 * check is meaningful — caller falls through to the index-collision
 * skip-existing logic.
 */
async function getActiveChainHeadPrevHash(
  chainDir: string,
): Promise<{ firstIndex: number; firstPrevHash: string } | null> {
  let files: string[];
  try {
    files = await fs.readdir(chainDir);
  } catch {
    return null;
  }
  const blockFiles = files
    .filter((f) => f.endsWith('.json') && !f.startsWith('.'))
    .map((f) => ({ file: f, index: Number.parseInt(f.replace('.json', ''), 10) }))
    .filter((e) => Number.isFinite(e.index))
    .sort((a, b) => a.index - b.index);

  if (blockFiles.length === 0) return null;
  const first = blockFiles[0]!;
  try {
    const raw = await fs.readFile(path.join(chainDir, first.file), 'utf8');
    const block = JSON.parse(raw) as ChainBlock;
    return { firstIndex: block.index, firstPrevHash: block.prev_hash };
  } catch {
    return null;
  }
}

export async function restoreChainFromArchive(
  chainName: string,
  archivePath: string,
  options: ChainArchiveRestoreOptions = {},
): Promise<ChainArchiveRestoreResult> {
  if (!SAFE_CHAIN_NAME.test(chainName)) {
    throw new ChainArchiveRestoreError(`invalid chain name: ${chainName}`, 'invalid-chain-name');
  }

  try {
    await fs.access(archivePath);
  } catch {
    throw new ChainArchiveRestoreError(`archive not found: ${archivePath}`, 'archive-not-found');
  }

  const crypto = options.crypto ?? (await import('node:crypto'));
  const skipExisting = options.skipExisting ?? true;

  const blocks = await readArchiveToBlocks(archivePath);
  if (blocks.length === 0) {
    throw new ChainArchiveRestoreError(
      `archive contained no blocks: ${archivePath}`,
      'empty-archive',
    );
  }

  // Step 1: per-block hash verification.
  for (const block of blocks) {
    const withoutHash = {
      index: block.index,
      timestamp: block.timestamp,
      chain: block.chain,
      data: block.data,
      prev_hash: block.prev_hash,
    };
    const expected = hashBlock(withoutHash, crypto);
    if (block.hash !== expected) {
      throw new ChainArchiveRestoreError(
        `hash mismatch at block ${block.index}: stored=${block.hash} expected=${expected}`,
        'hash-mismatch',
      );
    }
  }

  // Step 2: internal prev_hash chain.
  blocks.sort((a, b) => a.index - b.index);
  for (let i = 1; i < blocks.length; i += 1) {
    if (blocks[i].prev_hash !== blocks[i - 1].hash) {
      throw new ChainArchiveRestoreError(
        `prev_hash break between block ${blocks[i - 1].index} and ${blocks[i].index}`,
        'internal-chain-break',
      );
    }
  }

  // Step 3: continuity against the active chain's HEAD (prefix-restore semantics).
  // Codex Round 5 P1 fix: rotateChain archives the OLDEST blocks, so a
  // valid archive precedes the active chain. The archive's LAST block's
  // hash must equal the active chain's FIRST block's prev_hash.
  const chainDir = getChainPath(chainName, options.rawEnv);
  await fs.mkdir(chainDir, { recursive: true });
  const activeHead = await getActiveChainHeadPrevHash(chainDir);
  if (activeHead !== null && !options.allowDiscontinuousRestore) {
    // Only meaningful if the active chain doesn't start at block 1
    // (i.e. some rotation has occurred). If it starts at 1, the archive
    // either fully overlaps (handled by skipExisting) or is bogus.
    if (activeHead.firstIndex > 1) {
      const archiveLast = blocks[blocks.length - 1]!;
      if (archiveLast.hash !== activeHead.firstPrevHash) {
        throw new ChainArchiveRestoreError(
          `archive does not precede the active chain: active first.prev_hash=${activeHead.firstPrevHash}, archive last.hash=${archiveLast.hash}`,
          'discontinuous-with-active',
        );
      }
      // Also verify the index domains line up — archive should end one
      // block before the active chain starts.
      if (archiveLast.index !== activeHead.firstIndex - 1) {
        throw new ChainArchiveRestoreError(
          `archive last index ${archiveLast.index} does not abut active first index ${activeHead.firstIndex}`,
          'discontinuous-with-active',
        );
      }
    }
  }

  // Step 4: write blocks. Skip files that already exist.
  let restored = 0;
  let skipped = 0;
  for (const block of blocks) {
    const fileName = `${String(block.index).padStart(6, '0')}.json`;
    const fullPath = path.join(chainDir, fileName);
    try {
      await fs.access(fullPath);
      if (skipExisting) {
        skipped += 1;
        continue;
      }
    } catch {
      // file does not exist — proceed to write
    }
    const tmp = `${fullPath}.tmp-${process.pid}`;
    // The same serializer the append path uses, so a restored chain is
    // byte-identical to a chain that was never rotated.
    await fs.writeFile(tmp, serializeBlockForDisk(block), 'utf8');
    await fs.rename(tmp, fullPath);
    restored += 1;
  }

  return {
    chain: chainName,
    archivePath,
    blocksRead: blocks.length,
    blocksRestored: restored,
    firstIndex: blocks[0]?.index ?? null,
    lastIndex: blocks[blocks.length - 1]?.index ?? null,
    skippedExisting: skipped,
  };
}
