/**
 * Audio adapter — pin transcription path:
 *   - WAV input → POST raw bytes to whisper-server
 *   - non-200 from whisper-server → empty text (graceful)
 *   - network error → empty text
 *   - response with `text` field → exposed as text
 *   - response with `transcription` field → also exposed
 */
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { transcribeAudioFile } from '../../src/gateway/media/audio-adapter.js';

const ORIGINAL_FETCH = globalThis.fetch;
let tmpFile = '';

beforeEach(async () => {
  // Minimal WAV header so the adapter takes the no-transcode path.
  // Real WAV would be 44 bytes RIFF header + PCM data; we only need
  // the .wav extension trick for `looksLikeWavInput` plus arbitrary
  // bytes for the POST body.
  const wav = Buffer.from('RIFF$\x00\x00\x00WAVEfmt fake-data');
  tmpFile = path.join(os.tmpdir(), `audio-test-${Date.now()}.wav`);
  await fs.writeFile(tmpFile, wav);
});

afterEach(async () => {
  globalThis.fetch = ORIGINAL_FETCH;
  if (tmpFile) await fs.unlink(tmpFile).catch(() => undefined);
  vi.restoreAllMocks();
});

describe('transcribeAudioFile', () => {
  it('returns transcribed text from whisper-server response', async () => {
    globalThis.fetch = vi.fn(
      async () =>
        new Response(JSON.stringify({ text: 'cześć Memphis', language: 'pl' }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
    ) as unknown as typeof globalThis.fetch;

    const result = await transcribeAudioFile(tmpFile, {
      WHISPER_SERVER_URL: 'http://127.0.0.1:9000',
    });
    expect(result.kind).toBe('audio');
    expect(result.text).toBe('cześć Memphis');
    expect(result.language).toBe('pl');
  });

  it('falls back to `transcription` field when `text` is missing', async () => {
    globalThis.fetch = vi.fn(
      async () =>
        new Response(JSON.stringify({ transcription: 'old API field' }), { status: 200 }),
    ) as unknown as typeof globalThis.fetch;

    const result = await transcribeAudioFile(tmpFile, {
      WHISPER_SERVER_URL: 'http://127.0.0.1:9000',
    });
    expect(result.text).toBe('old API field');
  });

  it('returns empty text when whisper-server returns non-200', async () => {
    globalThis.fetch = vi.fn(
      async () => new Response('boom', { status: 500 }),
    ) as unknown as typeof globalThis.fetch;
    const result = await transcribeAudioFile(tmpFile, {
      WHISPER_SERVER_URL: 'http://127.0.0.1:9000',
    });
    expect(result.text).toBe('');
  });

  it('returns empty text on network exception', async () => {
    globalThis.fetch = vi.fn(async () => {
      throw new Error('ECONNREFUSED');
    }) as unknown as typeof globalThis.fetch;
    const result = await transcribeAudioFile(tmpFile, {
      WHISPER_SERVER_URL: 'http://127.0.0.1:9000',
    });
    expect(result.text).toBe('');
  });

  it('POSTs to /inference path with audio/wav content-type', async () => {
    const fetchSpy = vi.fn(
      async () => new Response(JSON.stringify({ text: 'ok' }), { status: 200 }),
    );
    globalThis.fetch = fetchSpy as unknown as typeof globalThis.fetch;

    await transcribeAudioFile(tmpFile, { WHISPER_SERVER_URL: 'http://127.0.0.1:9000' });
    expect(String(fetchSpy.mock.calls[0]![0])).toBe('http://127.0.0.1:9000/inference');
    const init = fetchSpy.mock.calls[0]![1] as RequestInit;
    expect(init.method).toBe('POST');
    expect((init.headers as Record<string, string>)['Content-Type']).toBe('audio/wav');
  });

  it('handles trailing slash in WHISPER_SERVER_URL without producing double slashes', async () => {
    const fetchSpy = vi.fn(
      async () => new Response(JSON.stringify({ text: 'ok' }), { status: 200 }),
    );
    globalThis.fetch = fetchSpy as unknown as typeof globalThis.fetch;
    await transcribeAudioFile(tmpFile, { WHISPER_SERVER_URL: 'http://127.0.0.1:9000/' });
    const url = String(fetchSpy.mock.calls[0]![0]);
    // No double slash AFTER the protocol scheme
    expect(url.replace(/^https?:\/\//, '')).not.toMatch(/\/\//);
  });
});
