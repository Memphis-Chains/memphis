/**
 * Chain rotation: archive old blocks when a chain directory exceeds a size threshold.
 *
 * Rotation creates a compressed archive of the oldest N blocks, removes them from the
 * active chain directory, and logs the rotation event. The chain continues seamlessly
 * because append always reads the current block set to determine the next index.
 */

import { createWriteStream } from 'node:fs';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { createGzip } from 'node:zlib';

import { getChainPath } from '../../config/paths.js';

const SAFE_CHAIN_NAME = /^[A-Za-z0-9_-]{1,64}$/;

/** Default rotation threshold: 50 MB per chain directory. */
const DEFAULT_ROTATION_THRESHOLD_BYTES = 50 * 1024 * 1024;

/** Minimum blocks to keep in the active chain after rotation. */
const MIN_KEEP_BLOCKS = 10;

export interface ChainRotationResult {
  chain: string;
  rotated: boolean;
  archivedBlocks: number;
  archivePath?: string;
  remainingBlocks: number;
  dirSizeBytes: number;
}

export interface ChainRotationOptions {
  /** Threshold in bytes. Rotate when chain dir exceeds this. */
  thresholdBytes?: number;
  /** Minimum blocks to keep in the active chain. */
  minKeepBlocks?: number;
  /** Specific chain name. If omitted, rotates all chains that exceed threshold. */
  chainName?: string;
}

/**
 * Measure total size of JSON block files in a chain directory.
 */
async function measureChainDirSize(chainDir: string): Promise<number> {
  const files = await fs.readdir(chainDir);
  let total = 0;
  for (const file of files) {
    if (!file.endsWith('.json')) continue;
    const stat = await fs.stat(path.join(chainDir, file));
    if (stat.isFile()) total += stat.size;
  }
  return total;
}

/**
 * List block files sorted by index ascending.
 */
async function listBlockFiles(chainDir: string): Promise<{ file: string; index: number }[]> {
  const files = await fs.readdir(chainDir);
  return files
    .filter((f) => f.endsWith('.json') && !f.startsWith('.'))
    .map((file) => ({ file, index: Number.parseInt(file.replace('.json', ''), 10) }))
    .filter((entry) => Number.isFinite(entry.index))
    .sort((a, b) => a.index - b.index);
}

/**
 * Archive blocks to a gzipped JSON file and remove originals.
 */
async function archiveBlocks(
  chainDir: string,
  chainName: string,
  blocks: { file: string; index: number }[],
): Promise<string> {
  const archiveDir = path.join(path.dirname(chainDir), '.archives');
  await fs.mkdir(archiveDir, { recursive: true });

  const firstIdx = blocks[0]!.index;
  const lastIdx = blocks[blocks.length - 1]!.index;
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const archiveName = `${chainName}_${String(firstIdx).padStart(6, '0')}-${String(lastIdx).padStart(6, '0')}_${timestamp}.jsonl.gz`;
  const archivePath = path.join(archiveDir, archiveName);

  // Write all blocks as newline-delimited JSON, gzipped
  const tmpPath = `${archivePath}.tmp-${process.pid}`;
  const gzip = createGzip({ level: 6 });
  const out = createWriteStream(tmpPath);
  const gzipPipeline = pipeline(gzip, out);

  for (const entry of blocks) {
    const content = await fs.readFile(path.join(chainDir, entry.file), 'utf8');
    gzip.write(content.trim() + '\n');
  }
  gzip.end();
  await gzipPipeline;

  // Atomic rename
  try {
    await fs.rename(tmpPath, archivePath);
  } catch {
    await fs.unlink(tmpPath).catch(() => undefined);
    throw new Error(`failed to finalize archive: ${archivePath}`);
  }

  // Remove archived block files
  for (const entry of blocks) {
    await fs.unlink(path.join(chainDir, entry.file)).catch(() => undefined);
  }

  return archivePath;
}

/**
 * Rotate a single chain if it exceeds the threshold.
 */
export async function rotateChain(
  chainName: string,
  options: ChainRotationOptions = {},
): Promise<ChainRotationResult> {
  const threshold = options.thresholdBytes ?? DEFAULT_ROTATION_THRESHOLD_BYTES;
  const minKeep = options.minKeepBlocks ?? MIN_KEEP_BLOCKS;

  const chainDir = getChainPath(chainName);
  let dirSize: number;

  try {
    dirSize = await measureChainDirSize(chainDir);
  } catch {
    return {
      chain: chainName,
      rotated: false,
      archivedBlocks: 0,
      remainingBlocks: 0,
      dirSizeBytes: 0,
    };
  }

  if (dirSize <= threshold) {
    const blocks = await listBlockFiles(chainDir);
    return {
      chain: chainName,
      rotated: false,
      archivedBlocks: 0,
      remainingBlocks: blocks.length,
      dirSizeBytes: dirSize,
    };
  }

  const blocks = await listBlockFiles(chainDir);
  if (blocks.length <= minKeep) {
    return {
      chain: chainName,
      rotated: false,
      archivedBlocks: 0,
      remainingBlocks: blocks.length,
      dirSizeBytes: dirSize,
    };
  }

  // Archive all but the last minKeep blocks
  const toArchive = blocks.slice(0, blocks.length - minKeep);
  const archivePath = await archiveBlocks(chainDir, chainName, toArchive);
  const newDirSize = await measureChainDirSize(chainDir);

  return {
    chain: chainName,
    rotated: true,
    archivedBlocks: toArchive.length,
    archivePath,
    remainingBlocks: blocks.length - toArchive.length,
    dirSizeBytes: newDirSize,
  };
}

/**
 * Rotate all chains that exceed the threshold.
 */
export async function rotateAllChains(
  options: ChainRotationOptions = {},
): Promise<ChainRotationResult[]> {
  const baseDir = getChainPath();
  let entries: string[];

  try {
    entries = await fs.readdir(baseDir);
  } catch {
    return [];
  }

  const chains = entries.filter((name) => SAFE_CHAIN_NAME.test(name));
  const results: ChainRotationResult[] = [];

  for (const chain of chains) {
    const result = await rotateChain(chain, options);
    results.push(result);
  }

  return results;
}
