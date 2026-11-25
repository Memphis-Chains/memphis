/**
 * The format of a chain rotation archive.
 *
 * ## Why this module exists
 *
 * A rotation archive is a gzipped file of chain blocks. Two pieces of
 * code read and write it, and for the whole life of the feature they
 * disagreed about what it contains — which is why every archive the
 * runtime ever produced was UNREADABLE.
 *
 * The writer (`chain-rotation.ts`) copied the raw bytes of each block
 * file. Block files are written pretty-printed — `JSON.stringify(block,
 * null, 2)` in `chain-adapter.ts` — so the archive was a stream of
 * multi-line JSON objects glued together by newlines.
 *
 * The reader (`chain-archive-restore.ts`) split the file on newlines
 * and ran `JSON.parse` on each line, which is what "JSON Lines" means:
 * one JSON value per line.
 *
 * Measured 2026-11-23 on this host, on a real rotation of the
 * `insights` chain (404 blocks, 31.92 MB, 297 blocks archived):
 *
 *     $ memphis chain restore --chain insights --file <archive>
 *     [INTERNAL_ERROR] parse error in archive: Expected property name
 *     or '}' in JSON at position 1 (line 1 column 2)
 *
 * The archive held 172 151 lines for 297 blocks, and the very first
 * line was `{` — which is not a JSON value. The restore died on line 1
 * of every archive it was ever pointed at.
 *
 * ## Why the test suite did not catch it
 *
 * `tests/unit/chain-archive-restore.test.ts` builds its fixtures with
 * `JSON.stringify(block)` — COMPACT, one block per line — which is a
 * format the production writer never produced. The gate was testing
 * the reader against a fixture from a writer that does not exist.
 *
 * That is the same failure this repository keeps meeting: a gate is
 * only as good as its corpus. The gate for this format now goes
 * through the real writer (`rotateChain`) and the real reader
 * (`restoreChainFromArchive`) — see
 * `tests/unit/chain-archive-roundtrip.test.ts`.
 *
 * ## The format
 *
 * An archive holds a SEQUENCE of JSON objects. Nothing else. The file
 * name says `.jsonl.gz`, so the writer emits true JSON Lines: one
 * object per line, no indentation. That is also smaller — the
 * indentation is a third of the bytes on disk.
 *
 * The reader does NOT assume one object per line. It splits the
 * stream into top-level JSON values, which means it reads BOTH:
 *
 *   - true JSON Lines (what the writer produces now), and
 *   - the legacy pretty-printed concatenation (what the writer
 *     produced before this fix).
 *
 * The legacy format has to stay readable. There is a real archive on
 * this host — `system_000001-015271_2026-11-22T15-57-33-906Z.jsonl.gz`,
 * 15 271 blocks of the `system` chain — and it is in the legacy
 * format. A reader that only understood the new format would strand
 * it.
 *
 * ## One format, one owner
 *
 * The writer and the reader both import THIS module. Neither of them
 * carries its own idea of the format, so the next change to either
 * side cannot silently diverge from the other — there is one place
 * that says what an archive is.
 *
 * There is no Rust reader for these archives: the rotation head
 * marker has a two-arm contract (`chain-rotation-head.ts` and
 * `crates/memphis-operator/src/chat_rotation_head.rs`), but the
 * archive BODY is read by the TypeScript arm only.
 */

import { createReadStream, readFileSync } from 'node:fs';
import { StringDecoder } from 'node:string_decoder';
import { createGunzip, gunzipSync } from 'node:zlib';

/**
 * The name of the directory the rotation puts its archives in, next to the
 * chains.
 *
 * One owner: the rotation writes it, the exact-search resolver reads it, and
 * the backup drill verifies what is inside it. Before this constant it was a
 * literal in three places, and a fourth reader would have made four.
 */
export const ARCHIVES_DIR_NAME = '.archives';

/** A JSON object, as it is stored inside an archive. */
export type ArchiveBlockValue = Record<string, unknown>;

/**
 * The result of scanning a buffer for complete JSON values.
 */
export interface ArchiveValueScan {
  /** The complete JSON values found, in the order they appear. */
  values: string[];
  /**
   * The part of the buffer that does not hold a complete value yet —
   * either a truncated value or trailing whitespace. The caller keeps it
   * and prepends it to the next chunk.
   */
  rest: string;
}

/**
 * The name of an archive file.
 *
 * Archives are named `{chain}_{firstIndex}-{lastIndex}_{timestamp}.jsonl.gz`.
 * The index RANGE is part of the name because it is what lets a reader
 * decide, without opening the file, whether an archive can hold the block
 * it is looking for — the rotation moves a PREFIX of a chain aside, and
 * the range says which prefix.
 *
 * One owner for the name: the writer (`chain-rotation.ts`) and every
 * reader (the restore path, the recall's archive fallback) go through the
 * functions below, so a chain whose name contains an underscore
 * (`autonom_archive`) cannot be mis-parsed by a reader that split on the
 * first underscore.
 */
export interface ArchiveFileName {
  /** The chain the archive belongs to. */
  chain: string;
  /** The first block index in the archive. */
  firstIndex: number;
  /** The last block index in the archive. */
  lastIndex: number;
  /** The timestamp part of the name, verbatim. */
  timestamp: string;
}

/**
 * The file name of an archive.
 *
 * @param chain the chain the archive belongs to.
 * @param firstIndex the first archived block index.
 * @param lastIndex the last archived block index.
 * @param timestamp the timestamp part, as the rotation writes it
 *   (`new Date().toISOString().replace(/[:.]/g, '-')`).
 */
export function archiveFileName(
  chain: string,
  firstIndex: number,
  lastIndex: number,
  timestamp: string,
): string {
  return `${chain}_${String(firstIndex).padStart(6, '0')}-${String(lastIndex).padStart(6, '0')}_${timestamp}.jsonl.gz`;
}

/**
 * Parse an archive file name, or return null when the name is not one.
 *
 * The parse works from the RIGHT: the timestamp is after the last
 * underscore, the index range is between the last two underscores, and
 * everything before that is the chain — whose name may itself contain
 * underscores.
 */
export function parseArchiveFileName(file: string): ArchiveFileName | null {
  if (!file.endsWith('.jsonl.gz')) return null;
  const stem = file.slice(0, -'.jsonl.gz'.length);

  const timestampStart = stem.lastIndexOf('_');
  if (timestampStart < 0) return null;
  const rangeStart = stem.lastIndexOf('_', timestampStart - 1);
  if (rangeStart < 0) return null;

  const chain = stem.slice(0, rangeStart);
  const range = stem.slice(rangeStart + 1, timestampStart);
  const timestamp = stem.slice(timestampStart + 1);

  const bounds = range.split('-');
  if (bounds.length !== 2) return null;
  const firstIndex = Number(bounds[0]);
  const lastIndex = Number(bounds[1]);
  if (!chain || !Number.isInteger(firstIndex) || !Number.isInteger(lastIndex)) return null;

  return { chain, firstIndex, lastIndex, timestamp };
}

/**
 * The blocks held by an archive's text.
 *
 * The text is what the archive file holds after decompression. The
 * scanner reads both the current format (one object per line) and the
 * legacy one (objects spread over many lines) — the archives already on
 * disk stay readable.
 *
 * @throws if a value is not a JSON object.
 */
export function parseArchiveBlocks(text: string): ArchiveBlockValue[] {
  return scanArchiveValues(text).values.map((value) => {
    const parsed = JSON.parse(value) as unknown;
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('an archive value is not a JSON object');
    }
    return parsed as ArchiveBlockValue;
  });
}

/**
 * The blocks held by an archive file, read synchronously.
 *
 * The synchronous reader exists for the callers that cannot await: the
 * recall's source resolver is synchronous, and it has to be able to read
 * the blocks the rotation moved aside.
 *
 * It uses the SAME scanner as the streaming reader in
 * `chain-archive-restore.ts`, so both read what the writer wrote —
 * including the legacy pretty-printed archives still on disk.
 *
 * @param archivePath the archive's path. A `.gz` file is decompressed.
 * @throws if the file cannot be read or a value is not a JSON object.
 */
export function readArchiveBlocksSync(archivePath: string): ArchiveBlockValue[] {
  const raw = readFileSync(archivePath);
  const text = archivePath.endsWith('.gz') ? gunzipSync(raw).toString('utf8') : raw.toString('utf8');
  return parseArchiveBlocks(text);
}

/**
 * The blocks an archive file holds, read WITHOUT holding the event loop.
 *
 * The synchronous reader above exists for the callers that cannot await; this
 * one is for the callers that must not freeze the runtime — the restore and
 * the backup drill both read archives of tens of thousands of blocks, and a
 * synchronous decompression of one is a pause of hundreds of milliseconds.
 *
 * The decompression is STREAMED, and a UTF-8 decoder holds the incomplete
 * tail of a chunk until the next one arrives: a multi-byte character that
 * straddles a chunk boundary is one character, not two.
 *
 * Measured 2026-11-23 on this host, on a real rotation of the `insights`
 * chain (297 blocks archived): 20 of the 297 lines came back corrupted, the
 * first of them at block 190 — where the restore then failed with "hash
 * mismatch at block 190", because the corrupted byte sat inside a
 * hash-covered field. Every corrupted character sat exactly two bytes before
 * a 16 KB chunk boundary: the two bytes of `ó` (0xC3 0xB3), split in half.
 *
 * @throws Error when a value cannot be parsed.
 */
export async function readArchiveBlocks(archivePath: string): Promise<ArchiveBlockValue[]> {
  const blocks: ArchiveBlockValue[] = [];
  await new Promise<void>((resolve, reject) => {
    const stream = createReadStream(archivePath).pipe(createGunzip());
    const decoder = new StringDecoder('utf8');
    let buffer = '';
    stream.on('data', (chunk: Buffer | string) => {
      buffer += typeof chunk === 'string' ? chunk : decoder.write(chunk);
      const scan = scanArchiveValues(buffer);
      buffer = scan.rest;
      for (const value of scan.values) {
        try {
          blocks.push(JSON.parse(value) as ArchiveBlockValue);
        } catch (err) {
          reject(
            new Error(
              `parse error in archive: ${err instanceof Error ? err.message : String(err)}`,
            ),
          );
          stream.destroy();
          return;
        }
      }
    });
    stream.on('end', () => {
      // Flush the decoder's tail — a truncated character at the very end of
      // the stream still has to be surfaced, not silently dropped.
      buffer += decoder.end();
      const tail = buffer.trim();
      if (tail) {
        try {
          blocks.push(JSON.parse(tail) as ArchiveBlockValue);
        } catch (err) {
          reject(
            new Error(
              `parse error at archive tail: ${err instanceof Error ? err.message : String(err)}`,
            ),
          );
          return;
        }
      }
      resolve();
    });
    stream.on('error', reject);
  });
  return blocks;
}

/**
 * Serialize one block file into one archive line.
 * The block file on disk is pretty-printed JSON. The archive line is
 * the same object, compact, on a single line.
 *
 * Re-serializing is safe for the block's hash: the canonical hash is
 * computed with `stableStringify` (`core/chain-hash.ts`), so it does
 * not depend on property order or on indentation.
 *
 * @param raw the raw bytes of a block file.
 * @param source the file name, for the error message.
 * @throws if the source is not a JSON object. The rotation aborts
 *   before it deletes anything, so a corrupt block file can never be
 *   turned into a corrupt archive.
 */
export function toArchiveLine(raw: string, source: string): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    throw new Error(`archive source ${source} is not valid JSON: ${detail}`);
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`archive source ${source} is not a JSON object`);
  }
  return JSON.stringify(parsed);
}

/**
 * Split a buffer into the complete JSON values it holds.
 *
 * A value is complete when its braces balance. Strings are tracked, so
 * a brace or a quote inside a string value never confuses the scanner.
 *
 * This reads the legacy pretty-printed format and true JSON Lines with
 * the same code: in both cases the blocks are simply a sequence of
 * JSON objects, and only the whitespace between them differs.
 */
export function scanArchiveValues(buffer: string): ArchiveValueScan {
  const values: string[] = [];
  let i = 0;

  while (i < buffer.length) {
    const ch = buffer[i]!;

    // Whitespace and the commas some JSON Lines writers put between
    // values are separators, not part of a value.
    if (ch === ' ' || ch === '\n' || ch === '\r' || ch === '\t' || ch === ',') {
      i += 1;
      continue;
    }

    const start = i;

    if (ch === '{' || ch === '[') {
      let depth = 0;
      let inString = false;
      let escaped = false;

      for (; i < buffer.length; i += 1) {
        const c = buffer[i]!;
        if (inString) {
          if (escaped) escaped = false;
          else if (c === '\\') escaped = true;
          else if (c === '"') inString = false;
          continue;
        }
        if (c === '"') {
          inString = true;
          continue;
        }
        if (c === '{' || c === '[') {
          depth += 1;
          continue;
        }
        if (c === '}' || c === ']') {
          depth -= 1;
          if (depth === 0) {
            i += 1;
            break;
          }
        }
      }

      if (depth !== 0) {
        // Truncated — keep it for the next chunk.
        return { values, rest: buffer.slice(start) };
      }

      values.push(buffer.slice(start, i));
      continue;
    }

    // A scalar value (a bare string, number, boolean or null) runs
    // until whitespace.
    while (i < buffer.length && !/[\s,]/.test(buffer[i]!)) i += 1;
    if (i >= buffer.length) {
      // Truncated — the last character may still be part of the value.
      return { values, rest: buffer.slice(start) };
    }
    values.push(buffer.slice(start, i));
  }

  return { values, rest: '' };
}
