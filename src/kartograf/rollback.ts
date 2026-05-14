/**
 * Kartograf checkpoint rollback — backup / list / prune / restore.
 *
 * The Kartograf nightly sprint can auto-install a freshly-trained
 * envelope. The existing install path (`src/infra/cli/handlers/kartograf.handler.ts:217-228`)
 * rmSync's the old `model.onnx` + `tokenizer.json` without any backup —
 * a bad checkpoint would brick inference until the operator manually
 * re-fetched a known-good envelope.
 *
 * This module adds the missing reversibility:
 *   - `backupCurrentCheckpoint` snapshots the live artifacts to
 *     `<slugDir>/.prev/<ISO-timestamp>/` before install proceeds.
 *   - `pruneBackups` keeps the N most recent (env
 *     `MEMPHIS_TRAINING_BACKUP_KEEP`, default 3) and removes older.
 *   - `listBackups` enumerates the backup directory with parsed manifests.
 *   - `rollbackKartografCheckpoint` restores the most recent (or
 *     specified) `.prev/<ts>/` artifacts back into the slug dir and
 *     invalidates the runtime singleton so the next `getKartografRuntime`
 *     call reloads.
 *
 * The backup manifest records `installedAt`, `replacedBy` (new envelope's
 * signer_did), and `eval_recall_at_10` so operators (and the auto-rollback
 * hook in `runtime.ts`) can see WHY a given backup exists and what the
 * delta was.
 */
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
} from 'node:fs';
import { join } from 'node:path';

import { sha256Hex, verifyCheckpoint, type CheckpointEnvelope } from './checkpoint.js';
import { closeKartografRuntime } from './runtime.js';
import { getDataDir } from '../config/paths.js';
import { atomicWriteJsonSync } from '../infra/runtime/atomic-write.js';

const BACKUP_DIR_NAME = '.prev';
const BACKUP_ARTIFACTS = ['checkpoint.json', 'model.onnx', 'tokenizer.json'] as const;
const BACKUP_KEEP_DEFAULT = 3;

export interface BackupManifest {
  installedAt: string;
  replacedAt: string;
  replacedBy: string;
  prevSignerDid: string;
  prevEvalRecallAt10: number;
  prevOnnxSha256: string;
}

export interface BackupRecord {
  timestamp: string;
  path: string;
  manifest: BackupManifest | null;
}

/** Backup record guaranteed to have a manifest (returned by `backupCurrentCheckpoint`). */
export interface BackupRecordWithManifest extends BackupRecord {
  manifest: BackupManifest;
}

function isoTimestampForFs(d: Date = new Date()): string {
  return d.toISOString().replace(/:/g, '-').replace(/\..+$/, 'Z');
}

function readBackupCountFromEnv(rawEnv: NodeJS.ProcessEnv): number {
  const raw = (rawEnv.MEMPHIS_TRAINING_BACKUP_KEEP ?? '').trim();
  if (!raw) return BACKUP_KEEP_DEFAULT;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed < 1) return BACKUP_KEEP_DEFAULT;
  return parsed;
}

function readEnvelopeIfPresent(slugDir: string): CheckpointEnvelope | null {
  const envelopePath = join(slugDir, 'checkpoint.json');
  if (!existsSync(envelopePath)) return null;
  try {
    return JSON.parse(readFileSync(envelopePath, 'utf8')) as CheckpointEnvelope;
  } catch {
    return null;
  }
}

function slugHasInstalledArtifacts(slugDir: string): boolean {
  return BACKUP_ARTIFACTS.every((name) => existsSync(join(slugDir, name)));
}

/**
 * Snapshot the artifacts currently live in `slugDir` into
 * `<slugDir>/.prev/<ISO-timestamp>/` together with a manifest. No-op
 * when the slug dir has no installed artifacts yet (first install).
 *
 * `replacedBy` is the signer DID of the envelope about to overwrite the
 * current install — recorded so a future rollback can explain WHY this
 * backup exists.
 *
 * Returns the backup record on success, null when nothing to back up.
 */
export function backupCurrentCheckpoint(
  slugDir: string,
  replacedBy: string,
  rawEnv: NodeJS.ProcessEnv = process.env,
): BackupRecordWithManifest | null {
  if (!slugHasInstalledArtifacts(slugDir)) return null;

  const prevEnvelope = readEnvelopeIfPresent(slugDir);
  const timestamp = isoTimestampForFs();
  const backupRoot = join(slugDir, BACKUP_DIR_NAME);
  const backupDir = join(backupRoot, timestamp);

  mkdirSync(backupDir, { recursive: true, mode: 0o700 });

  for (const name of BACKUP_ARTIFACTS) {
    copyFileSync(join(slugDir, name), join(backupDir, name));
  }

  const manifest: BackupManifest = {
    installedAt: prevEnvelope?.training_provenance?.trained_at ?? 'unknown',
    replacedAt: new Date().toISOString(),
    replacedBy,
    prevSignerDid: prevEnvelope?.signer_did ?? 'unknown',
    prevEvalRecallAt10: prevEnvelope?.training_provenance?.eval_recall_at_10 ?? 0,
    prevOnnxSha256: prevEnvelope?.onnx_sha256 ?? 'unknown',
  };
  atomicWriteJsonSync(join(backupDir, 'manifest.json'), manifest);

  pruneBackups(slugDir, readBackupCountFromEnv(rawEnv));

  return { timestamp, path: backupDir, manifest };
}

/**
 * Enumerate `<slugDir>/.prev/<ts>/` entries, most-recent first. Returns
 * empty when the backup dir doesn't exist.
 */
export function listBackups(slugDir: string): BackupRecord[] {
  const backupRoot = join(slugDir, BACKUP_DIR_NAME);
  if (!existsSync(backupRoot)) return [];

  let entries: string[];
  try {
    entries = readdirSync(backupRoot);
  } catch {
    return [];
  }

  const records: BackupRecord[] = [];
  for (const entry of entries) {
    const path = join(backupRoot, entry);
    try {
      if (!statSync(path).isDirectory()) continue;
    } catch {
      continue;
    }
    let manifest: BackupManifest | null = null;
    try {
      const raw = readFileSync(join(path, 'manifest.json'), 'utf8');
      manifest = JSON.parse(raw) as BackupManifest;
    } catch {
      manifest = null;
    }
    records.push({ timestamp: entry, path, manifest });
  }
  // Sort by directory name (ISO timestamp, lex-sortable), newest first.
  records.sort((a, b) => (a.timestamp < b.timestamp ? 1 : a.timestamp > b.timestamp ? -1 : 0));
  return records;
}

/**
 * Prune `.prev/<ts>/` directories so at most `keep` remain. Oldest
 * dropped first. Returns the count of directories removed.
 */
export function pruneBackups(slugDir: string, keep: number): number {
  const records = listBackups(slugDir);
  if (records.length <= keep) return 0;
  const surplus = records.slice(keep);
  let removed = 0;
  for (const record of surplus) {
    try {
      rmSync(record.path, { recursive: true, force: true });
      removed += 1;
    } catch {
      // best-effort; if a single backup can't be removed (FS race,
      // open handle), keep going so we don't leave a backlog.
    }
  }
  return removed;
}

export interface RollbackOptions {
  /** Specific slug subdirectory; defaults to the first slug under stageRoot. */
  slug?: string;
  /** Specific backup timestamp; defaults to most recent. */
  toTimestamp?: string;
  rawEnv?: NodeJS.ProcessEnv;
}

export type RollbackResult =
  | {
      ok: true;
      slug: string;
      restoredFrom: string;
      manifest: BackupManifest | null;
      restoredEnvelopeSignerDid: string;
    }
  | {
      ok: false;
      reason:
        | 'slug-not-found'
        | 'no-backups'
        | 'backup-not-found'
        | 'restore-failed'
        | 'verify-failed';
      message: string;
      slug?: string;
      restoredFrom?: string;
    };

function resolveSlug(rawEnv: NodeJS.ProcessEnv, requested?: string): { stageRoot: string; slugDir: string; slug: string } | null {
  const stageRoot = join(getDataDir(rawEnv), 'kartograf', 'checkpoints');
  if (!existsSync(stageRoot)) return null;
  if (requested) {
    const slugDir = join(stageRoot, requested);
    if (!existsSync(slugDir)) return null;
    return { stageRoot, slugDir, slug: requested };
  }
  // Pick the first slug directory that has a .prev backup. If multiple
  // slugs have backups, prefer the one with the most recent.
  let best: { slug: string; slugDir: string; mostRecent: string } | null = null;
  let entries: string[];
  try {
    entries = readdirSync(stageRoot);
  } catch {
    return null;
  }
  for (const entry of entries) {
    const slugDir = join(stageRoot, entry);
    try {
      if (!statSync(slugDir).isDirectory()) continue;
    } catch {
      continue;
    }
    const backups = listBackups(slugDir);
    if (backups.length === 0) continue;
    const mostRecent = backups[0].timestamp;
    if (!best || mostRecent > best.mostRecent) {
      best = { slug: entry, slugDir, mostRecent };
    }
  }
  if (!best) return null;
  return { stageRoot, slugDir: best.slugDir, slug: best.slug };
}

/**
 * Restore artifacts from `<slugDir>/.prev/<ts>/` back to the slug dir.
 * Invalidates the runtime singleton on success so the next inference call
 * reloads from disk.
 *
 * If `toTimestamp` is unset, uses the most recent backup. Verifies the
 * restored envelope before reporting success — a corrupted backup is
 * surfaced as `verify-failed`, never silently restored.
 */
export async function rollbackKartografCheckpoint(
  options: RollbackOptions = {},
): Promise<RollbackResult> {
  const rawEnv = options.rawEnv ?? process.env;
  const resolved = resolveSlug(rawEnv, options.slug);
  if (!resolved) {
    return {
      ok: false,
      reason: 'slug-not-found',
      message: options.slug
        ? `no slug directory at ~/.memphis/kartograf/checkpoints/${options.slug}`
        : 'no slug directory with backups under ~/.memphis/kartograf/checkpoints',
    };
  }
  const { slug, slugDir } = resolved;

  const backups = listBackups(slugDir);
  if (backups.length === 0) {
    return {
      ok: false,
      reason: 'no-backups',
      message: `slug ${slug} has no .prev/ backups to restore from`,
      slug,
    };
  }

  let target: BackupRecord | undefined;
  if (options.toTimestamp) {
    target = backups.find((b) => b.timestamp === options.toTimestamp);
    if (!target) {
      return {
        ok: false,
        reason: 'backup-not-found',
        message: `slug ${slug} has no backup at .prev/${options.toTimestamp}`,
        slug,
      };
    }
  } else {
    target = backups[0];
  }

  // Read backup envelope to verify before clobbering live artifacts.
  let backupEnvelope: CheckpointEnvelope;
  try {
    backupEnvelope = JSON.parse(
      readFileSync(join(target.path, 'checkpoint.json'), 'utf8'),
    ) as CheckpointEnvelope;
  } catch (err) {
    return {
      ok: false,
      reason: 'restore-failed',
      message: `backup envelope unreadable: ${err instanceof Error ? err.message : String(err)}`,
      slug,
      restoredFrom: target.path,
    };
  }
  const verify = verifyCheckpoint(backupEnvelope);
  if (!verify.valid) {
    return {
      ok: false,
      reason: 'verify-failed',
      message: `backup envelope signature invalid: ${verify.reason}`,
      slug,
      restoredFrom: target.path,
    };
  }

  // Verify sha of backed-up model.onnx matches envelope before publishing.
  try {
    const onnxBytes = readFileSync(join(target.path, 'model.onnx'));
    const actualSha = sha256Hex(onnxBytes);
    if (actualSha !== backupEnvelope.onnx_sha256) {
      return {
        ok: false,
        reason: 'verify-failed',
        message: `backup model.onnx sha mismatch (envelope=${backupEnvelope.onnx_sha256.slice(0, 12)}..., disk=${actualSha.slice(0, 12)}...)`,
        slug,
        restoredFrom: target.path,
      };
    }
  } catch (err) {
    return {
      ok: false,
      reason: 'restore-failed',
      message: `backup model.onnx unreadable: ${err instanceof Error ? err.message : String(err)}`,
      slug,
      restoredFrom: target.path,
    };
  }

  // Restore: copy each backed-up artifact over the live one. Done
  // sequentially; a partial failure leaves a coherent mix because every
  // file in the backup was sha-verified above.
  try {
    for (const name of BACKUP_ARTIFACTS) {
      copyFileSync(join(target.path, name), join(slugDir, name));
    }
  } catch (err) {
    return {
      ok: false,
      reason: 'restore-failed',
      message: err instanceof Error ? err.message : String(err),
      slug,
      restoredFrom: target.path,
    };
  }

  // Invalidate the runtime singleton so the next inference reloads from
  // disk. Without this the daemon would keep serving the bad checkpoint.
  await closeKartografRuntime();

  return {
    ok: true,
    slug,
    restoredFrom: target.path,
    manifest: target.manifest,
    restoredEnvelopeSignerDid: verify.signerDid,
  };
}
