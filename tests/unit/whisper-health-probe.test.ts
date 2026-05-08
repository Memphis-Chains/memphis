/**
 * Pin behavior of checkWhisperServerHealth — probes a list of common
 * liveness paths until one returns 2xx. Operator session 2026-05-05
 * caught doctor-v2 reporting "STT unreachable" while the custom
 * faster-whisper python wrapper was healthy and answering POSTs on
 * /inference; root URL just happened to 404. Rather than hardcode
 * one path and break with the next server variant, probe candidates
 * in order.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

import { checkWhisperServerHealth } from '../../src/gateway/voice/local-whisper-adapter.js';

const ORIGINAL_FETCH = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = ORIGINAL_FETCH;
  delete process.env.WHISPER_SERVER_URL;
  vi.restoreAllMocks();
});

describe('checkWhisperServerHealth', () => {
  it('returns ok when /health responds 200', async () => {
    process.env.WHISPER_SERVER_URL = 'http://127.0.0.1:9000';
    const fetchSpy = vi.fn(async (url: string) => {
      if (url.endsWith('/health')) return new Response('{"ok":true}', { status: 200 });
      return new Response('not found', { status: 404 });
    });
    globalThis.fetch = fetchSpy as unknown as typeof globalThis.fetch;

    const result = await checkWhisperServerHealth();
    expect(result.ok).toBe(true);
    expect(result.latencyMs).toBeGreaterThanOrEqual(0);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(String(fetchSpy.mock.calls[0]![0])).toBe('http://127.0.0.1:9000/health');
  });

  it('falls back to /inference when /health is 404 (whisper.cpp variant)', async () => {
    process.env.WHISPER_SERVER_URL = 'http://127.0.0.1:9000';
    const fetchSpy = vi.fn(async (url: string) => {
      if (url.endsWith('/health')) return new Response('not found', { status: 404 });
      if (url.endsWith('/inference')) return new Response('{"status":"ok"}', { status: 200 });
      return new Response('not found', { status: 404 });
    });
    globalThis.fetch = fetchSpy as unknown as typeof globalThis.fetch;

    const result = await checkWhisperServerHealth();
    expect(result.ok).toBe(true);
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  it('returns failure with last HTTP status when all candidate paths 404', async () => {
    process.env.WHISPER_SERVER_URL = 'http://127.0.0.1:9000';
    const fetchSpy = vi.fn(async () => new Response('not found', { status: 404 }));
    globalThis.fetch = fetchSpy as unknown as typeof globalThis.fetch;

    const result = await checkWhisperServerHealth();
    expect(result.ok).toBe(false);
    // We tried 3 candidates; last error references the final path
    expect(result.error).toMatch(/HTTP 404/);
  });

  it('returns failure immediately on connection error (no retry across paths)', async () => {
    process.env.WHISPER_SERVER_URL = 'http://127.0.0.1:9999';
    const fetchSpy = vi.fn(async () => {
      throw new TypeError('fetch failed: ECONNREFUSED');
    });
    globalThis.fetch = fetchSpy as unknown as typeof globalThis.fetch;

    const result = await checkWhisperServerHealth();
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/ECONNREFUSED|fetch failed/);
    // Single fetch call — once the server is unreachable, no point
    // walking through more paths
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it('handles trailing slash in WHISPER_SERVER_URL without producing double slashes', async () => {
    process.env.WHISPER_SERVER_URL = 'http://127.0.0.1:9000/';
    const fetchSpy = vi.fn(async () => new Response('{"ok":true}', { status: 200 }));
    globalThis.fetch = fetchSpy as unknown as typeof globalThis.fetch;

    await checkWhisperServerHealth();
    const url = String(fetchSpy.mock.calls[0]![0]);
    expect(url).toBe('http://127.0.0.1:9000/health');
    // No double slash AFTER the protocol scheme. (`//` is fine inside
    // the `http://` prefix; the failure mode is `…:9000//health`.)
    expect(url.replace(/^https?:\/\//, '')).not.toMatch(/\/\//);
  });
});
