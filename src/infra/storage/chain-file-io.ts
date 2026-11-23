/**
 * Low-level block-file I/O primitives shared by rust-chain-adapter and case-chain-adapter.
 *
 * Extracted to a single module so the safety-critical read/write paths live in exactly
 * one place. See issue #70 for the incident that motivated propagating parse errors
 * instead of silently treating a corrupted chain as empty.
 */

import { randomUUID } from 'node:crypto';
import {
  access,
  link,
  mkdir,
  open,
  readFile,
  readdir,
  unlink,
  writeFile,
} from 'node:fs/promises';
import { join } from 'node:path';

import { withChainWriteLock } from './chain-write-lock.js';

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

// ── Envelope parsing ─────────────────────────────────────────────────────────

/**
 * Parse a Rust NAPI bridge envelope of the form `{ ok, data, error }`. Throws a
 * descriptive error on malformed JSON, a non-ok envelope, or a missing `data` field.
 *
 * The implementation lives in `bridge-envelope.ts` — it is the single place
 * the Rust bridge's JSON contract is understood. This re-export keeps the
 * existing import path working.
 */
export { parseEnvelope, callBridge, type BridgeEnvelope } from './bridge-envelope.js';

// ── Block file I/O ───────────────────────────────────────────────────────────

/**
 * The canonical on-disk form of a block file.
 *
 * One rule, one place.
 *
 * Three paths write block files — the append path, the repair path and
 * the archive restore path — and they have to write them the SAME way.
 *
 * The restore path used to write compact JSON while everything else
 * wrote pretty-printed JSON. The chain still verified either way (the
 * hash covers the block's VALUES, not its bytes), but a restored chain
 * was not byte-identical to a chain that had never been rotated, and
 * nothing said why. With one serializer, "the archive round trip is
 * lossless" becomes a property that can be checked with `cmp`.
 */
export function serializeBlockForDisk(block: unknown): string {
  return JSON.stringify(block, null, 2);
}

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
 * synced temporary file and atomic, exclusive publication. Creates the
 * directory if missing. Existing blocks at ANY index are never replaced.
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

  const tmpFilename = `${filename}.tmp-${process.pid}-${randomUUID()}`;
  await writeFile(tmpFilename, payload, 'utf8');
  const staged = await open(tmpFilename, 'r');
  try {
    await staged.sync();
  } finally {
    await staged.close();
  }
  try {
    // link is atomic and fails with EEXIST; rename would replace the target.
    // A competing writer must never be able to destroy a committed block.
    await link(tmpFilename, filename);
    await unlink(tmpFilename).catch(() => undefined);
    const directory = await open(dir, 'r');
    try {
      await directory.sync();
    } finally {
      await directory.close();
    }
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
      // Preserve the published file for investigation. Another writer could
      // have changed it; deleting or restoring bytes here may destroy evidence.
      throw new Error(
        `writeBlockAtomic verification failed for ${filename}: ` +
          `on-disk content does not match payload (len ${written.length} vs ${payload.length}). ` +
          `This indicates a partial write, race condition, or serializer divergence. ` +
          `Published block preserved for investigation.`,
      );
    }
  } catch (verificationError) {
    // Rethrow our own verification error; ignore IO errors that would mask the
    // real failure (the file was already published).
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
      `writeBlockAtomic: post-publication verify IO error (non-fatal): ${String(verificationError)}`,
    );
  }
  return filename;
}

// ── Append lock ──────────────────────────────────────────────────────────────

/** Same allocation lock as TS fallback and the native operator. */
export async function withNapiAppendLock<T>(chainsDir: string, fn: () => Promise<T>): Promise<T> {
  return withChainWriteLock(chainsDir, fn);
}
