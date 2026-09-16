/**
 * Low-level block-file I/O primitives shared by rust-chain-adapter and case-chain-adapter.
 *
 * Extracted to a single module so the safety-critical read/write paths live in exactly
 * one place. See issue #70 for the incident that motivated propagating parse errors
 * instead of silently treating a corrupted chain as empty.
 */

import {
  access,
  mkdir,
  open,
  readFile,
  readdir,
  rename,
  stat,
  unlink,
  writeFile,
} from 'node:fs/promises';
import { join } from 'node:path';

// ── Shared types ─────────────────────────────────────────────────────────────

export interface NapiBlockData {
  type: string;
  content: string;
  tags: string[];
  [key: string]: unknown;
}

export interface NapiBlock {
  index: number;
  timestamp: string;
  chain: string;
  data: NapiBlockData;
  prev_hash: string;
  hash: string;
  signer?: string;
  signature?: string;
}

export interface BridgeEnvelope<T> {
  ok: boolean;
  data?: T;
  error?: string;
}

// ── Envelope parsing ─────────────────────────────────────────────────────────

/**
 * Parse a Rust NAPI bridge envelope of the form `{ ok, data, error }`. Throws a
 * descriptive error on malformed JSON, a non-ok envelope, or a missing `data` field.
 */
export function parseEnvelope<T>(raw: string, fnName: string): T {
  let out: BridgeEnvelope<T>;
  try {
    out = JSON.parse(raw) as BridgeEnvelope<T>;
  } catch (error) {
    throw new Error(`${fnName}: invalid JSON response (${String(error)})`, { cause: error });
  }

  if (!out.ok) {
    throw new Error(`${fnName}: ${out.error ?? 'bridge returned error'}`);
  }

  if (out.data === undefined) {
    throw new Error(`${fnName}: bridge returned empty data`);
  }

  return out.data;
}

// ── Block file I/O ───────────────────────────────────────────────────────────

/**
 * List `.json` block files in a chain directory, sorted lexicographically.
 * Returns an empty array when the directory does not exist (first-run case).
 * Any other `readdir` error (permission, I/O) is propagated — we never want
 * to silently mask a real storage failure.
 */
export async function listBlockFiles(dir: string): Promise<string[]> {
  try {
    const entries = await readdir(dir, { withFileTypes: true });
    return entries
      .filter((entry) => entry.isFile() && entry.name.endsWith('.json'))
      .map((entry) => entry.name)
      .sort();
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') return [];
    throw error;
  }
}

/**
 * Read + parse a single block file. Throws a descriptive error on JSON parse
 * failure rather than returning null — a corrupted block must never be silently
 * treated as "chain is empty" because that causes the next append to regenerate
 * a fresh genesis and overwrite the existing index-0 file (see issue #70).
 */
export async function readBlockFile<T = NapiBlock>(filePath: string): Promise<T> {
  const raw = await readFile(filePath, 'utf8');
  try {
    return JSON.parse(raw) as T;
  } catch (error) {
    throw new Error(
      `chain block parse failed for ${filePath}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

/**
 * Atomically write a block payload to `${dir}/${index:06}.json` using a
 * tmp-file + rename. Creates the directory if missing.
 *
 * Refuses to overwrite an existing genesis block (index 0) as defense in depth —
 * if the caller ever miscomputes the next index as 0 (e.g. from a buggy empty-chain
 * path), we must not silently rewrite the real genesis. See issue #70.
 *
 * Returns the final file path.
 */
export async function writeBlockAtomic(
  dir: string,
  index: number,
  payload: string,
): Promise<string> {
  await mkdir(dir, { recursive: true });
  const filename = join(dir, `${String(index).padStart(6, '0')}.json`);

  if (index === 0) {
    try {
      await access(filename);
      throw new Error(
        `refusing to overwrite existing genesis block at ${filename} — chain may be in an inconsistent state`,
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code !== 'ENOENT') throw error;
    }
  }

  // Capture previous content (if any) so we can roll back to it if the
  // post-rename verification discovers the on-disk content does not match
  // the intended payload. This guards against partial writes, race conditions,
  // and serializer divergence (e.g. Rust NAPIbridge appending trailing
  // characters to a JSON object — observed in cases chain 2026-09-07 and
  // 2026-09-11, decision #98/#146).
  let previousBytes: string | undefined;
  try {
    const prev = await stat(filename).catch(() => undefined);
    if (prev?.isFile()) {
      previousBytes = await readFile(filename, 'utf8');
    }
  } catch {
    // best-effort: if stat/read fails, fall through without rollback option
  }

  const tmpFilename = `${filename}.tmp-${process.pid}-${Date.now()}`;
  await writeFile(tmpFilename, payload, 'utf8');
  try {
    await rename(tmpFilename, filename);
  } catch (error) {
    await unlink(tmpFilename).catch(() => undefined);
    throw error;
  }

  // Read-after-write verification: the on-disk file must match what we
  // intended to write. If a race condition, partial flush, or a buggy
  // serializer appended trailing garbage, this catches it BEFORE the runtime
  // tries to read the block during the next cognitive prelude.
  try {
    const written = await readFile(filename, 'utf8');
    if (written !== payload) {
      // Rollback to previous content (if any) before throwing so the chain
      // does not contain a silently-corrupt block.
      if (previousBytes !== undefined) {
        await writeFile(filename, previousBytes, 'utf8');
      } else {
        // The block did not exist before; the safest rollback is to remove
        // it entirely so the next-index computation treats this slot as empty.
        await unlink(filename).catch(() => undefined);
      }
      throw new Error(
        `writeBlockAtomic verification failed for ${filename}: ` +
        `on-disk content does not match payload (len ${written.length} vs ${payload.length}). ` +
        `This indicates a partial write, race condition, or serializer divergence. ` +
        `Block rolled back to previous content. Re-run the originating append.`,
      );
    }
  } catch (verificationError) {
    // Rethrow our own verification error; ignore IO errors that would mask the
    // real failure (the file rename already succeeded).
    if (
      verificationError instanceof Error &&
      verificationError.message.startsWith('writeBlockAtomic verification failed')
    ) {
      throw verificationError;
    }
    // For unexpected IO errors during verification, log and proceed (the
    // rename already happened; do not double-throw which would mask the
    // success path).
     
    console.error(
      `writeBlockAtomic: post-rename verify IO error (non-fatal): ${String(verificationError)}`,
    );
  }
  return filename;
}

// ── Append lock ──────────────────────────────────────────────────────────────

const NAPI_LOCK_FILE = '.napi-append.lock';
const NAPI_LOCK_MAX_ATTEMPTS = 200;
const NAPI_LOCK_RETRY_MS = 10;
const NAPI_LOCK_STALE_MS = 30_000;

/**
 * Serialize chain append operations against a single chains directory via an
 * exclusive lock file. Callers that read, compute, and write must wrap the
 * entire cycle in this lock so concurrent writers cannot race on the next-index
 * computation.
 *
 * A lock file older than `NAPI_LOCK_STALE_MS` is considered abandoned (from a
 * crashed process) and forcibly unlinked.
 */
export async function withNapiAppendLock<T>(chainsDir: string, fn: () => Promise<T>): Promise<T> {
  const lockPath = join(chainsDir, NAPI_LOCK_FILE);
  await mkdir(chainsDir, { recursive: true });

  for (let attempt = 0; attempt < NAPI_LOCK_MAX_ATTEMPTS; attempt += 1) {
    try {
      const lockHandle = await open(lockPath, 'wx');
      try {
        return await fn();
      } finally {
        await lockHandle.close().catch(() => undefined);
        await unlink(lockPath).catch(() => undefined);
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code !== 'EEXIST') {
        throw error;
      }
      try {
        const lockStat = await stat(lockPath);
        if (Date.now() - lockStat.mtimeMs > NAPI_LOCK_STALE_MS) {
          await unlink(lockPath).catch(() => undefined);
          continue;
        }
      } catch {
        continue;
      }
      await new Promise((resolve) => setTimeout(resolve, NAPI_LOCK_RETRY_MS));
    }
  }

  throw new Error(`napi chain append lock timeout for ${chainsDir}`);
}
