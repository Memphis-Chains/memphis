/**
 * A byte stream becomes text — and a character is a character.
 *
 * ## The failure this exists for
 *
 * `chunk.toString('utf8')` decodes each chunk ON ITS OWN. A multi-byte
 * character that straddles a chunk boundary is ONE character, not a
 * character plus a fragment, and decoding the halves separately turns it
 * into two U+FFFD replacement characters.
 *
 * Measured 2026-11-23 on this host, on a real rotation of the `insights`
 * chain (297 blocks archived): the archive reader used
 * `chunk.toString('utf8')`, and **20 of the 297 lines came back
 * corrupted**. The first corrupted line was block 190, where the restore
 * failed with `hash mismatch at block 190`. Every corrupted character sat
 * exactly two bytes before a 16 KB chunk boundary — the two bytes of `ó`
 * (0xC3 0xB3), split in half.
 *
 * The same pattern was in three transport paths that carry MCP traffic:
 * the HTTP request body, the native socket and the CLI MCP client. MCP
 * tool arguments carry the operator's own text, and Polish diacritics are
 * two bytes.
 *
 * ## What each test pins
 *
 *   - "a character split across two chunks is one character" — the
 *     mechanism, deterministically.
 *   - "decoding each chunk on its own is what the decoder prevents" — the
 *     falsifier's witness: the old way, shown losing the character.
 *   - "the native transport hands the handler the exact text" — the
 *     wiring, over a real socket with a real split.
 */
import { Buffer } from 'node:buffer';
import { connect } from 'node:net';

import { describe, expect, it } from 'vitest';

import { startNativeMcpTransport } from '../../src/bridges/mcp-native-transport.js';
import { createUtf8StreamDecoder, readStreamAsText } from '../../src/core/utf8-stream.js';

/** A Polish pangram — every diacritic the operator actually types. */
const POLISH = 'Zażółć gęślą jaźń — Pchnąć w tę łódź jeża lub ośm skrzyń fig.';

describe('a byte stream becomes text', () => {
  it('a character split across two chunks is one character', () => {
    const bytes = Buffer.from('ó', 'utf8');
    expect(bytes.length).toBe(2);

    const decoder = createUtf8StreamDecoder();
    const text =
      decoder.push(bytes.subarray(0, 1)) + decoder.push(bytes.subarray(1)) + decoder.end();

    expect(text).toBe('ó');
    expect(text).not.toContain('\uFFFD');
  });

  it('decoding each chunk on its own is what the decoder prevents', () => {
    // The falsifier's witness — the old way, shown losing the character.
    const bytes = Buffer.from('ó', 'utf8');
    const naive = bytes.subarray(0, 1).toString('utf8') + bytes.subarray(1).toString('utf8');

    expect(naive).not.toBe('ó');
    expect(naive).toContain('\uFFFD');
  });

  it('reads a whole stream across chunk boundaries', async () => {
    const bytes = Buffer.from(POLISH, 'utf8');
    const stream = new (await import('node:stream')).Readable({
      read() {
        this.push(bytes.subarray(0, 7));
        this.push(bytes.subarray(7, 19));
        this.push(bytes.subarray(19));
        this.push(null);
      },
    });

    const text = await readStreamAsText(stream);
    expect(text).toBe(POLISH);
    expect(text).not.toContain('\uFFFD');
  });

  it('the native transport hands the handler the exact text', async () => {
    // A real socket, a real split: the payload is written in two halves
    // with a gap between them, and the split falls in the middle of a
    // two-byte character.
    const request = {
      jsonrpc: '2.0' as const,
      id: 1,
      method: 'ask',
      params: { input: POLISH },
    };
    const payload = JSON.stringify(request);
    const payloadBytes = Buffer.from(payload, 'utf8');

    // The split point: the middle of the two-byte `ó` in "Zażółć".
    const marker = Buffer.from('ó', 'utf8');
    const markerAt = payloadBytes.indexOf(marker);
    expect(markerAt).toBeGreaterThan(0);
    const splitAt = markerAt + 1;

    let resolveReceived: (value: unknown) => void = () => {};
    const receivedPromise = new Promise<unknown>((resolve) => {
      resolveReceived = resolve;
    });
    const transport = await startNativeMcpTransport(
      async (req) => {
        resolveReceived(req);
        return { jsonrpc: '2.0', id: req.id, result: {} };
      },
      { host: '127.0.0.1', port: 0 },
    );

    const client = connect({ host: transport.host, port: transport.port });
    client.setNoDelay(true);
    try {
      await new Promise<void>((resolve, reject) => {
        client.once('connect', resolve);
        client.once('error', reject);
      });

      client.write(payloadBytes.subarray(0, splitAt));
      // The gap is what makes the split a real one: the server reads the
      // first half as its own chunk.
      await new Promise((resolve) => setTimeout(resolve, 60));
      client.write(payloadBytes.subarray(splitAt));
      client.end();

      const received = await receivedPromise;
      expect(received).not.toBeNull();
      const params = (received as { params?: { input?: string } }).params;
      expect(params?.input).toBe(POLISH);
      expect(params?.input).not.toContain('\uFFFD');
    } finally {
      client.destroy();
      await transport.close();
    }
  });
});
