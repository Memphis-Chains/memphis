/**
 * Decoding a byte stream as text.
 *
 * ## Why this module exists
 *
 * `chunk.toString('utf8')` decodes each chunk ON ITS OWN. That is fine
 * for ASCII and wrong for everything else: a multi-byte character that
 * straddles a chunk boundary is not a character plus a fragment, it is
 * ONE character, and decoding the halves separately turns it into two
 * U+FFFD replacement characters.
 *
 * Measured 2026-11-23 on this host, on a real rotation of the `insights`
 * chain (297 blocks archived): the archive reader used `chunk.toString
 * ('utf8')`, and **20 of the 297 lines came back corrupted**. The first
 * corrupted line was block 190, where the restore failed with `hash
 * mismatch at block 190`. Every corrupted character sat exactly two
 * bytes before a 16 KB chunk boundary — the two bytes of `ó` (0xC3
 * 0xB3), split in half.
 *
 * The same pattern was in three transport paths that carry MCP traffic:
 *
 *   - `src/mcp/transport/http.ts` — the HTTP request body. MCP tool
 *     arguments carry the operator's own text, and Polish diacritics are
 *     two bytes.
 *   - `src/bridges/mcp-native-transport.ts` — the native socket.
 *   - `src/infra/cli/commands/mcp.ts` — the CLI MCP client.
 *
 * `StringDecoder` holds the incomplete tail of a chunk until the next one
 * arrives, so the character survives the boundary.
 *
 * ## One rule, one place
 *
 * The decoder lives here so that the next stream does not grow its own
 * idea of how bytes become text. `readStreamAsText` is the common case
 * (read it all); `createUtf8StreamDecoder` is for the callers that have
 * to look at the text before the stream ends.
 */

import type { Readable } from 'node:stream';
import { StringDecoder } from 'node:string_decoder';

/** A decoder that turns a byte stream into text across chunk boundaries. */
export interface Utf8StreamDecoder {
  /**
   * Decode one chunk. Returns the text that is COMPLETE — a character
   * that continues into the next chunk is held back until it does.
   */
  push(chunk: Buffer | string): string;
  /**
   * Flush the decoder at the end of the stream. A truncated character
   * still has to be surfaced, not silently dropped.
   */
  end(): string;
}

/**
 * A UTF-8 decoder that survives chunk boundaries.
 *
 * A chunk that is already a string is passed through untouched — a
 * stream that delivers text has no encoding boundary to get wrong.
 */
export function createUtf8StreamDecoder(): Utf8StreamDecoder {
  const decoder = new StringDecoder('utf8');
  return {
    push(chunk: Buffer | string): string {
      return typeof chunk === 'string' ? chunk : decoder.write(chunk);
    },
    end(): string {
      return decoder.end();
    },
  };
}

/**
 * Read a readable stream to the end as UTF-8 text.
 *
 * The whole point is the boundary: the text is decoded with one decoder
 * for the whole stream, so a character that straddles two chunks is
 * still one character.
 */
export function readStreamAsText(stream: Readable): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const decoder = createUtf8StreamDecoder();
    let text = '';
    stream.on('data', (chunk: Buffer | string) => {
      text += decoder.push(chunk);
    });
    stream.on('end', () => {
      text += decoder.end();
      resolve(text);
    });
    stream.on('error', (err) => reject(err));
  });
}
