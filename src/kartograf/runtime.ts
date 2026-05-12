/**
 * Process-level singleton for the active Kartograf session.
 *
 * Loading a real ONNX session means reading ~700 MB of model weights from
 * disk + initializing onnxruntime-node graph optimization. Doing that
 * per-tool-call would be untenable for the daemon path (one call = ~3-8 s
 * cold-load on CPU; spec line 200 budget says < 25 ms p95 warm). The
 * singleton here keeps a single loaded session in memory and serves all
 * callers; first call pays the load cost, subsequent calls are warm.
 *
 * The CLI path (`memphis kartograf query`) bypasses this singleton — each
 * CLI invocation is a fresh process so caching wouldn't help, and the CLI
 * also explicitly closes() at exit. For daemon-side tool calls, code
 * should reach for `getKartografRuntime()`.
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

import { verifyCheckpoint, type CheckpointEnvelope } from './checkpoint.js';
import { createKartografSession, type KartografSession } from './session.js';
import { getDataDir } from '../config/paths.js';

export type KartografRuntimeStatus =
  | { kind: 'disabled'; reason: string }
  | { kind: 'no-checkpoint'; reason: string }
  | { kind: 'load-failed'; reason: string; checkpointPath: string }
  | { kind: 'ready'; session: KartografSession; envelopePath: string };

let cached: KartografRuntimeStatus | null = null;
let loading: Promise<KartografRuntimeStatus> | null = null;

/**
 * Resolve the first verifiable installed checkpoint envelope. Returns
 * null if no install dir, no slug subdirs, or every envelope fails
 * verify — caller decides how to surface that to the operator.
 */
function findFirstVerifiedEnvelope(rawEnv: NodeJS.ProcessEnv): {
  envelopePath: string;
  envelope: CheckpointEnvelope;
} | null {
  const stageRoot = join(getDataDir(rawEnv), 'kartograf', 'checkpoints');
  if (!existsSync(stageRoot)) return null;
  let slugs: string[];
  try {
    slugs = readdirSync(stageRoot).filter((entry) => {
      try {
        return statSync(join(stageRoot, entry)).isDirectory();
      } catch {
        return false;
      }
    });
  } catch {
    return null;
  }
  for (const slug of slugs) {
    const envelopePath = join(stageRoot, slug, 'checkpoint.json');
    if (!existsSync(envelopePath)) continue;
    try {
      const envelope = JSON.parse(readFileSync(envelopePath, 'utf8')) as CheckpointEnvelope;
      const verify = verifyCheckpoint(envelope);
      if (!verify.valid) continue;
      return { envelopePath, envelope };
    } catch {
      // Try next slug
    }
  }
  return null;
}

/**
 * Get (or lazily create) the singleton Kartograf runtime. Returns a
 * status discriminator the caller can pattern-match against — production
 * tools should refuse to operate when status !== 'ready' rather than
 * silently using zero embeddings.
 */
export async function getKartografRuntime(
  rawEnv: NodeJS.ProcessEnv = process.env,
): Promise<KartografRuntimeStatus> {
  if (cached) return cached;
  if (loading) return loading;

  loading = (async (): Promise<KartografRuntimeStatus> => {
    if (rawEnv.MEMPHIS_KARTOGRAF_ENABLE !== '1') {
      const status: KartografRuntimeStatus = {
        kind: 'disabled',
        reason: 'MEMPHIS_KARTOGRAF_ENABLE=1 not set in environment',
      };
      cached = status;
      return status;
    }
    const found = findFirstVerifiedEnvelope(rawEnv);
    if (!found) {
      const status: KartografRuntimeStatus = {
        kind: 'no-checkpoint',
        reason: 'no verifiable checkpoint under ~/.memphis/kartograf/checkpoints',
      };
      cached = status;
      return status;
    }
    try {
      const session = await createKartografSession(
        {
          checkpointPath: found.envelopePath,
          headsConfig: found.envelope.heads_config,
        },
        rawEnv,
      );
      // createKartografSession may itself fall back to a stub on internal
      // load failure (e.g. ABI mismatch). Detect that and surface as
      // load-failed so callers don't think they have a real session.
      if (session.checkpointId.startsWith('stub:')) {
        const status: KartografRuntimeStatus = {
          kind: 'load-failed',
          reason:
            'createKartografSession fell back to stub (see daemon stderr for ONNX load reason)',
          checkpointPath: found.envelopePath,
        };
        cached = status;
        return status;
      }
      const status: KartografRuntimeStatus = {
        kind: 'ready',
        session,
        envelopePath: found.envelopePath,
      };
      cached = status;
      return status;
    } catch (err) {
      const status: KartografRuntimeStatus = {
        kind: 'load-failed',
        reason: err instanceof Error ? err.message : String(err),
        checkpointPath: found.envelopePath,
      };
      cached = status;
      return status;
    }
  })();

  try {
    return await loading;
  } finally {
    loading = null;
  }
}

/**
 * Release the singleton session — called from the graceful shutdown
 * path so we don't leak ORT handles. Idempotent.
 */
export async function closeKartografRuntime(): Promise<void> {
  if (!cached || cached.kind !== 'ready') {
    cached = null;
    return;
  }
  const session = cached.session;
  cached = null;
  await session.close();
}

/**
 * Test-only: forget the cached runtime so a new load attempt runs.
 * Production code must NOT call this — concurrent callers will see
 * inconsistent state.
 */
export function _resetKartografRuntimeForTests(): void {
  cached = null;
  loading = null;
}
