/**
 * Vision adapter — pin behavior across model output shapes:
 *   - "TAGS:" line present → description + tags split correctly
 *   - "TAGS:" line absent → whole text as description, empty tags
 *   - non-200 from Ollama → empty description (silent fail to keep
 *     orchestrator graceful)
 *   - network error → same
 */
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { describeImage } from '../../src/gateway/media/vision-adapter.js';

const ORIGINAL_FETCH = globalThis.fetch;

let tmpFile = '';

beforeEach(async () => {
  // 1×1 transparent PNG — minimal valid bytes the adapter can read
  // without ffprobe / image libraries. Header gives 32×32 dimensions
  // when we craft an explicit IHDR; here we use a tiny 1×1 to keep
  // the byte count low and the test fast.
  const png1x1 = Buffer.from([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, // signature
    0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52, // IHDR length+name
    0x00, 0x00, 0x00, 0x01, // width = 1
    0x00, 0x00, 0x00, 0x01, // height = 1
    0x08, 0x06, 0x00, 0x00, 0x00, // bit depth, color type, ...
    0x1f, 0x15, 0xc4, 0x89, // CRC
  ]);
  tmpFile = path.join(os.tmpdir(), `vision-test-${Date.now()}.png`);
  await fs.writeFile(tmpFile, png1x1);
});

afterEach(async () => {
  globalThis.fetch = ORIGINAL_FETCH;
  if (tmpFile) {
    await fs.unlink(tmpFile).catch(() => undefined);
  }
  vi.restoreAllMocks();
});

describe('describeImage', () => {
  it('parses TAGS: line into separate description + tags array', async () => {
    globalThis.fetch = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            response:
              'Na zdjęciu: budynek drewniany w stylu beskidzkim, dwie osoby.\nTAGS: budynek, drewno, beskid, osoby',
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        ),
    ) as unknown as typeof globalThis.fetch;

    const result = await describeImage(tmpFile, {}, { OLLAMA_URL: 'http://test' });
    expect(result.kind).toBe('image');
    expect(result.description).toContain('budynek drewniany');
    expect(result.description).not.toContain('TAGS:');
    expect(result.tags).toEqual(['budynek', 'drewno', 'beskid', 'osoby']);
  });

  it('returns whole-text description and empty tags when model omits TAGS line', async () => {
    globalThis.fetch = vi.fn(
      async () =>
        new Response(JSON.stringify({ response: 'Krajobraz górski.' }), { status: 200 }),
    ) as unknown as typeof globalThis.fetch;

    const result = await describeImage(tmpFile, {}, { OLLAMA_URL: 'http://test' });
    expect(result.description).toBe('Krajobraz górski.');
    expect(result.tags).toEqual([]);
  });

  it('returns empty result when Ollama returns non-200', async () => {
    globalThis.fetch = vi.fn(
      async () => new Response('model not found', { status: 404 }),
    ) as unknown as typeof globalThis.fetch;
    const result = await describeImage(tmpFile, {}, { OLLAMA_URL: 'http://test' });
    expect(result.description).toBe('');
    expect(result.tags).toEqual([]);
  });

  it('returns empty result on network exception (orchestrator stays graceful)', async () => {
    globalThis.fetch = vi.fn(async () => {
      throw new Error('ECONNREFUSED');
    }) as unknown as typeof globalThis.fetch;
    const result = await describeImage(tmpFile, {}, { OLLAMA_URL: 'http://test' });
    expect(result.description).toBe('');
  });

  it('uses MEMPHIS_MEDIA_VISION_MODEL env override when set', async () => {
    const fetchSpy = vi.fn(
      async () => new Response(JSON.stringify({ response: 'x' }), { status: 200 }),
    );
    globalThis.fetch = fetchSpy as unknown as typeof globalThis.fetch;

    await describeImage(
      tmpFile,
      {},
      { OLLAMA_URL: 'http://test', MEMPHIS_MEDIA_VISION_MODEL: 'llava' },
    );
    const body = JSON.parse((fetchSpy.mock.calls[0]![1] as RequestInit).body as string);
    expect(body.model).toBe('llava');
  });

  it('reads PNG dimensions from header when available', async () => {
    globalThis.fetch = vi.fn(
      async () =>
        new Response(
          JSON.stringify({ response: 'desc\nTAGS: a, b' }),
          { status: 200 },
        ),
    ) as unknown as typeof globalThis.fetch;
    const result = await describeImage(tmpFile, {}, { OLLAMA_URL: 'http://test' });
    expect(result.dimensions).toEqual({ width: 1, height: 1 });
  });

  it('honors --model override option', async () => {
    const fetchSpy = vi.fn(
      async () => new Response(JSON.stringify({ response: 'x' }), { status: 200 }),
    );
    globalThis.fetch = fetchSpy as unknown as typeof globalThis.fetch;
    await describeImage(tmpFile, { model: 'custom-model' }, { OLLAMA_URL: 'http://test' });
    const body = JSON.parse((fetchSpy.mock.calls[0]![1] as RequestInit).body as string);
    expect(body.model).toBe('custom-model');
  });

  it('honors --prompt override option', async () => {
    const fetchSpy = vi.fn(
      async () => new Response(JSON.stringify({ response: 'x' }), { status: 200 }),
    );
    globalThis.fetch = fetchSpy as unknown as typeof globalThis.fetch;
    await describeImage(tmpFile, { prompt: 'Describe in English.' }, { OLLAMA_URL: 'http://test' });
    const body = JSON.parse((fetchSpy.mock.calls[0]![1] as RequestInit).body as string);
    expect(body.prompt).toBe('Describe in English.');
  });
});
