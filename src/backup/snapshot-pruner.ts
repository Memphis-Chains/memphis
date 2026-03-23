/**
 * Snapshot pruning: remove old snapshots based on retention policy.
 *
 * Integrates with the existing RollbackManager snapshot format.
 * Snapshots are individual JSON files in {dataDir}/snapshots/.
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';

/** Default retention: keep snapshots from the last 7 days. */
const DEFAULT_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

/** Always keep at least this many snapshots regardless of age. */
const DEFAULT_MIN_KEEP = 3;

export interface SnapshotPruneResult {
  pruned: number;
  kept: number;
  freedBytes: number;
  errors: string[];
}

export interface SnapshotPruneOptions {
  /** Maximum age in milliseconds. Snapshots older than this are candidates for pruning. */
  maxAgeMs?: number;
  /** Minimum snapshots to keep regardless of age. */
  minKeep?: number;
  /** Dry run: report what would be pruned without deleting. */
  dryRun?: boolean;
}

interface SnapshotFileInfo {
  file: string;
  fullPath: string;
  timestamp: number;
  sizeBytes: number;
}

/**
 * Parse snapshot timestamp from the standard filename format: snapshot-{timestamp}.json
 */
function parseSnapshotTimestamp(filename: string): number | null {
  const match = /^snapshot-(\d+)\.json$/.exec(filename);
  if (!match) return null;
  const ts = Number.parseInt(match[1]!, 10);
  return Number.isFinite(ts) ? ts : null;
}

/**
 * List all snapshots with metadata, sorted by timestamp descending (newest first).
 */
async function listSnapshotFiles(snapshotDir: string): Promise<SnapshotFileInfo[]> {
  let files: string[];
  try {
    files = await fs.readdir(snapshotDir);
  } catch {
    return [];
  }

  const infos: SnapshotFileInfo[] = [];
  for (const file of files) {
    if (!file.endsWith('.json')) continue;

    const ts = parseSnapshotTimestamp(file);
    if (ts === null) continue;

    const fullPath = path.join(snapshotDir, file);
    try {
      const stat = await fs.stat(fullPath);
      if (stat.isFile()) {
        infos.push({ file, fullPath, timestamp: ts, sizeBytes: stat.size });
      }
    } catch {
      // Skip files that can't be stat'd
    }
  }

  return infos.sort((a, b) => b.timestamp - a.timestamp);
}

/**
 * Prune old snapshots from the given directory.
 */
export async function pruneSnapshots(
  snapshotDir: string,
  options: SnapshotPruneOptions = {},
): Promise<SnapshotPruneResult> {
  const maxAgeMs = options.maxAgeMs ?? DEFAULT_MAX_AGE_MS;
  const minKeep = options.minKeep ?? DEFAULT_MIN_KEEP;
  const dryRun = options.dryRun ?? false;

  const snapshots = await listSnapshotFiles(snapshotDir);
  const cutoff = Date.now() - maxAgeMs;

  // Always keep the newest minKeep snapshots
  const safe = snapshots.slice(0, minKeep);
  const candidates = snapshots.slice(minKeep);

  const toPrune = candidates.filter((s) => s.timestamp < cutoff);
  const errors: string[] = [];
  let freedBytes = 0;

  if (!dryRun) {
    for (const snapshot of toPrune) {
      try {
        await fs.unlink(snapshot.fullPath);
        freedBytes += snapshot.sizeBytes;
      } catch (err) {
        errors.push(
          `failed to delete ${snapshot.file}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
  } else {
    freedBytes = toPrune.reduce((sum, s) => sum + s.sizeBytes, 0);
  }

  return {
    pruned: dryRun ? toPrune.length : toPrune.length - errors.length,
    kept: safe.length + candidates.length - toPrune.length + (dryRun ? 0 : errors.length),
    freedBytes,
    errors,
  };
}
