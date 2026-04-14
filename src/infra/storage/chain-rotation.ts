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

import { getChainPath, getChainSnapshotsPath } from '../../config/paths.js';

const SAFE_CHAIN_NAME = /^[A-Za-z0-9_-]{1,64}$/;

/** Default rotation threshold: 50 MB per chain directory. */
const DEFAULT_ROTATION_THRESHOLD_BYTES = 50 * 1024 * 1024;

/** Minimum blocks to keep in the active chain after rotation. */
const MIN_KEEP_BLOCKS = 10;

/** Default archive retention — current + last-N gzipped archives. */
export const DEFAULT_ARCHIVE_KEEP = 8;

/** Snapshot scope: how many trailing blocks to capture in each snapshot. */
export const DEFAULT_SNAPSHOT_TAIL_BLOCKS = 1000;

export interface ChainRotationResult {
  chain: string;
  rotated: boolean;
  archivedBlocks: number;
  archivePath?: string;
  remainingBlocks: number;
  dirSizeBytes: number;
  /** Populated when this chain's rotation threw (per-chain isolation). */
  error?: string;
}

export interface ChainRotationOptions {
  /** Threshold in bytes. Rotate when chain dir exceeds this. */
  thresholdBytes?: number;
  /** Minimum blocks to keep in the active chain. */
  minKeepBlocks?: number;
  /** Specific chain name. If omitted, rotates all chains that exceed threshold. */
  chainName?: string;
  /**
   * Override of `MEMPHIS_CHAIN_GC_ENABLED`. When true, prune old gzipped
   * archives after a successful rotation.
   */
  gcEnabled?: boolean;
  /** Number of recent archives to keep when GC runs. Default 8. */
  gcKeep?: number;
  /** When true, write a snapshot to `data/chain-snapshots/` before archiving. */
  snapshotEnabled?: boolean;
  /** Trailing block count to capture per snapshot. Default 1000. */
  snapshotTailBlocks?: number;
  /** Optional override for the snapshot directory (mostly for tests). */
  snapshotDir?: string;
  /** Override the env used to resolve config paths/flags (mostly for tests). */
  rawEnv?: NodeJS.ProcessEnv;
}

export interface ChainArchiveGcResult {
  chain: string;
  archivesScanned: number;
  archivesDeleted: number;
  bytesFreed: number;
  keptArchives: string[];
  deletedArchives: string[];
  enabled: boolean;
}

export interface ChainSnapshotResult {
  chain: string;
  snapshotPath: string;
  blockCount: number;
  bytesWritten: number;
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

function isGcEnabled(options: ChainRotationOptions): boolean {
  if (typeof options.gcEnabled === 'boolean') return options.gcEnabled;
  const rawEnv = options.rawEnv ?? process.env;
  const flag = rawEnv.MEMPHIS_CHAIN_GC_ENABLED?.trim().toLowerCase();
  return flag === 'true' || flag === '1';
}

function isSnapshotEnabled(options: ChainRotationOptions): boolean {
  if (typeof options.snapshotEnabled === 'boolean') return options.snapshotEnabled;
  const rawEnv = options.rawEnv ?? process.env;
  const flag = rawEnv.MEMPHIS_CHAIN_SNAPSHOT_ON_ROTATION?.trim().toLowerCase();
  // Default to true — snapshots are local-only, cheap, and the safety net the
  // sprint targets. Operators can opt out with MEMPHIS_CHAIN_SNAPSHOT_ON_ROTATION=false.
  if (flag === 'false' || flag === '0') return false;
  return true;
}

function parseArchiveTimestamp(filename: string): number | null {
  // archives are named: {chain}_{firstIdx}-{lastIdx}_{ISO-with-dashes}.jsonl.gz
  // Treat the trailing component before .jsonl.gz as a sortable string; we
  // additionally use mtime as a fallback in case the format ever changes.
  if (!filename.endsWith('.jsonl.gz')) return null;
  const stem = filename.slice(0, -'.jsonl.gz'.length);
  const lastUnderscore = stem.lastIndexOf('_');
  if (lastUnderscore < 0) return null;
  const stampToken = stem.slice(lastUnderscore + 1);
  const parsed = Date.parse(stampToken.replace(/-/g, ':').replace('T:', 'T'));
  return Number.isFinite(parsed) ? parsed : null;
}

interface ArchiveFileInfo {
  file: string;
  fullPath: string;
  ts: number;
  sizeBytes: number;
}

async function listArchives(
  archiveDir: string,
  chainName: string,
): Promise<ArchiveFileInfo[]> {
  let entries: string[];
  try {
    entries = await fs.readdir(archiveDir);
  } catch {
    return [];
  }
  const candidates: ArchiveFileInfo[] = [];
  for (const file of entries) {
    if (!file.startsWith(`${chainName}_`)) continue;
    if (!file.endsWith('.jsonl.gz')) continue;
    const fullPath = path.join(archiveDir, file);
    const stat = await fs.stat(fullPath).catch(() => null);
    if (!stat || !stat.isFile()) continue;
    const parsed = parseArchiveTimestamp(file);
    candidates.push({
      file,
      fullPath,
      ts: parsed ?? stat.mtimeMs,
      sizeBytes: stat.size,
    });
  }
  return candidates.sort((a, b) => a.ts - b.ts);
}

/**
 * Delete old gzipped archives for a chain, keeping the most-recent N.
 *
 * Always a no-op unless GC is explicitly enabled — `MEMPHIS_CHAIN_GC_ENABLED=true`
 * or `options.gcEnabled === true`. Returns a structured report so callers can
 * audit/display what happened.
 */
function readEnvKeepArchives(rawEnv: NodeJS.ProcessEnv | undefined): number | undefined {
  const raw = (rawEnv ?? process.env).MEMPHIS_CHAIN_GC_KEEP_ARCHIVES?.trim();
  if (!raw) return undefined;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 1) return undefined;
  return Math.floor(parsed);
}

function readEnvSnapshotTailBlocks(rawEnv: NodeJS.ProcessEnv | undefined): number | undefined {
  const raw = (rawEnv ?? process.env).MEMPHIS_CHAIN_SNAPSHOT_TAIL_BLOCKS?.trim();
  if (!raw) return undefined;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 1) return undefined;
  return Math.floor(parsed);
}

export async function archiveGC(
  chainName: string,
  options: Pick<ChainRotationOptions, 'gcEnabled' | 'gcKeep' | 'rawEnv'> = {},
): Promise<ChainArchiveGcResult> {
  const enabled = isGcEnabled(options);
  // Codex P2 fix (PR #85): honor MEMPHIS_CHAIN_GC_KEEP_ARCHIVES env so
  // operators can configure retention via /config set instead of having
  // to plumb gcKeep through every call site. Precedence: explicit option
  // > env > DEFAULT_ARCHIVE_KEEP.
  const keep = Math.max(
    1,
    options.gcKeep ?? readEnvKeepArchives(options.rawEnv) ?? DEFAULT_ARCHIVE_KEEP,
  );
  const chainDir = getChainPath(chainName, options.rawEnv);
  const archiveDir = path.join(path.dirname(chainDir), '.archives');

  const archives = await listArchives(archiveDir, chainName);
  if (!enabled || archives.length <= keep) {
    return {
      chain: chainName,
      archivesScanned: archives.length,
      archivesDeleted: 0,
      bytesFreed: 0,
      keptArchives: archives.map((a) => a.file),
      deletedArchives: [],
      enabled,
    };
  }
  const toDelete = archives.slice(0, archives.length - keep);
  const kept = archives.slice(archives.length - keep);
  let bytesFreed = 0;
  const deleted: string[] = [];
  for (const archive of toDelete) {
    try {
      await fs.unlink(archive.fullPath);
      bytesFreed += archive.sizeBytes;
      deleted.push(archive.file);
    } catch {
      // Best-effort: a missing or locked archive is logged via the deletedArchives gap.
    }
  }
  return {
    chain: chainName,
    archivesScanned: archives.length,
    archivesDeleted: deleted.length,
    bytesFreed,
    keptArchives: kept.map((a) => a.file),
    deletedArchives: deleted,
    enabled,
  };
}

/**
 * Capture a lightweight chain snapshot before a rotation.
 *
 * Snapshots are JSON files at `data/chain-snapshots/snapshot-{ts}.json` and
 * record { chain, takenAt, head, tail: Block[] }. They are intentionally
 * compatible with `pruneSnapshots()` (`src/backup/snapshot-pruner.ts`) so old
 * snapshots age out together with the rest.
 */
export async function takeChainSnapshot(
  chainName: string,
  options: Pick<ChainRotationOptions, 'snapshotTailBlocks' | 'snapshotDir' | 'rawEnv'> = {},
): Promise<ChainSnapshotResult> {
  // Codex P2 fix (PR #85): honor MEMPHIS_CHAIN_SNAPSHOT_TAIL_BLOCKS env
  // so operators can size snapshots via /config set. Precedence: explicit
  // option > env > DEFAULT_SNAPSHOT_TAIL_BLOCKS (1000).
  const envTailBlocks = readEnvSnapshotTailBlocks(options.rawEnv);
  const tailLimit = Math.max(
    1,
    options.snapshotTailBlocks ?? envTailBlocks ?? DEFAULT_SNAPSHOT_TAIL_BLOCKS,
  );
  const snapshotDir = options.snapshotDir ?? getChainSnapshotsPath(options.rawEnv);
  await fs.mkdir(snapshotDir, { recursive: true });

  const chainDir = getChainPath(chainName, options.rawEnv);
  const blocks = await listBlockFiles(chainDir);
  const tail = blocks.slice(-tailLimit);

  const tailContents: unknown[] = [];
  for (const entry of tail) {
    try {
      const raw = await fs.readFile(path.join(chainDir, entry.file), 'utf8');
      tailContents.push(JSON.parse(raw));
    } catch {
      // Skip unreadable blocks rather than failing the whole snapshot.
    }
  }

  const head = tailContents.length > 0 ? tailContents[tailContents.length - 1] : null;
  const ts = Date.now();
  const snapshotPath = path.join(snapshotDir, `snapshot-${ts}.json`);
  const payload = {
    chain: chainName,
    takenAt: new Date(ts).toISOString(),
    blockCount: blocks.length,
    tailLimit,
    head,
    tail: tailContents,
    schemaVersion: 1,
  };
  const tmpPath = `${snapshotPath}.tmp-${process.pid}`;
  const serialized = `${JSON.stringify(payload)}\n`;
  await fs.writeFile(tmpPath, serialized, 'utf8');
  await fs.rename(tmpPath, snapshotPath);

  return {
    chain: chainName,
    snapshotPath,
    blockCount: blocks.length,
    bytesWritten: Buffer.byteLength(serialized, 'utf8'),
  };
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

  // Snapshot first so the operator has a recovery point even if archiving fails.
  if (isSnapshotEnabled(options)) {
    try {
      await takeChainSnapshot(chainName, options);
    } catch {
      // Snapshot is best-effort; rotation is more important than the safety net.
    }
  }

  // Archive all but the last minKeep blocks
  const toArchive = blocks.slice(0, blocks.length - minKeep);
  const archivePath = await archiveBlocks(chainDir, chainName, toArchive);
  const newDirSize = await measureChainDirSize(chainDir);

  // GC stale archives — opt-in via MEMPHIS_CHAIN_GC_ENABLED.
  await archiveGC(chainName, options).catch(() => undefined);

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
 *
 * Codex Round 5 P1 fix: per-chain errors are ISOLATED. One corrupted or
 * locked chain must not block rotation of the others, otherwise a
 * single broken chain poisons the whole scheduled run indefinitely.
 * Failures show up as `{ rotated: false, error }` in the result slot
 * so callers can still report + alert per-chain.
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
    try {
      const result = await rotateChain(chain, options);
      results.push(result);
    } catch (err) {
      results.push({
        chain,
        rotated: false,
        archivedBlocks: 0,
        remainingBlocks: 0,
        dirSizeBytes: 0,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return results;
}
