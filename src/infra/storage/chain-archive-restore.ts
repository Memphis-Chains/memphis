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
 *   1. Gunzip the archive into memory (streamed; each line is one block).
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
import { createGunzip } from 'node:zlib';

import { hashBlock, type ChainBlock } from './chain-adapter.js';
import { getChainPath } from '../../config/paths.js';

const SAFE_CHAIN_NAME = /^[A-Za-z0-9_-]{1,64}$/;

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
    let buffer = '';
    stream.on('data', (chunk: Buffer | string) => {
      buffer += chunk.toString('utf8');
      let newlineIdx: number;
      while ((newlineIdx = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, newlineIdx).trim();
        buffer = buffer.slice(newlineIdx + 1);
        if (!line) continue;
        try {
          blocks.push(JSON.parse(line) as ChainBlock);
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

async function getActiveChainTailHash(chainDir: string): Promise<string | null> {
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
  const last = blockFiles[blockFiles.length - 1]!;
  try {
    const raw = await fs.readFile(path.join(chainDir, last.file), 'utf8');
    const block = JSON.parse(raw) as ChainBlock;
    return block.hash;
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
    throw new ChainArchiveRestoreError(
      `invalid chain name: ${chainName}`,
      'invalid-chain-name',
    );
  }

  try {
    await fs.access(archivePath);
  } catch {
    throw new ChainArchiveRestoreError(
      `archive not found: ${archivePath}`,
      'archive-not-found',
    );
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

  // Step 3: continuity against the active chain's tail.
  const chainDir = getChainPath(chainName, options.rawEnv);
  await fs.mkdir(chainDir, { recursive: true });
  const activeTailHash = await getActiveChainTailHash(chainDir);
  if (activeTailHash !== null && !options.allowDiscontinuousRestore) {
    if (blocks[0].prev_hash !== activeTailHash) {
      throw new ChainArchiveRestoreError(
        `archive does not continue the active chain: active tail=${activeTailHash}, archive first prev_hash=${blocks[0].prev_hash}`,
        'discontinuous-with-active',
      );
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
    await fs.writeFile(tmp, JSON.stringify(block), 'utf8');
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
