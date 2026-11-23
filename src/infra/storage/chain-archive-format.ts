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
 * Serialize one block file into one archive line.
 *
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
