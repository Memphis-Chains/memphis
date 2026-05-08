/**
 * Pin operator-actionable error classification for STT failures.
 *
 * Operator session 2026-05-05 22:24+22:27: Whisper server died, bot
 * relayed raw "STT error: fetch failed" with no remediation hint.
 * Sprint ε replaced the bare-error pass-through with classifyWhisperError
 * which translates ECONNREFUSED / ENOTFOUND / timeout / aborted shapes
 * into messages that name the URL and tell the operator what to do.
 *
 * Tests run speechToTextLocal with mocked fetch failures and assert the
 * returned `error` message contains the server URL plus the remediation
 * keyword.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

import { speechToTextLocal } from '../../src/gateway/voice/local-whisper-adapter.js';

const ORIGINAL_FETCH = globalThis.fetch;

// Stub ffmpeg so the test never actually shells out — we don't have
// audio data anyway, just need the path to reach the fetch call.
vi.mock('child_process', () => ({
  execFile: (
    _bin: string,
    _args: string[],
    _opts: unknown,
    cb: (err: Error | null) => void,
  ) => {
    cb(null);
  },
}));

vi.mock('fs', async () => {
  const actual = await vi.importActual<typeof import('fs')>('fs');
  return {
    ...actual,
    writeFileSync: () => undefined,
    readFileSync: () => Buffer.alloc(64), // fake WAV bytes
    existsSync: () => false, // skip cleanup
    unlinkSync: () => undefined,
  };
});

afterEach(() => {
  globalThis.fetch = ORIGINAL_FETCH;
  delete process.env.WHISPER_SERVER_URL;
});

describe('speechToTextLocal — error classification (Sprint ε)', () => {
  it('translates ECONNREFUSED into operator-actionable message', async () => {
    process.env.WHISPER_SERVER_URL = 'http://127.0.0.1:9000';
    const cause = new Error('connect ECONNREFUSED 127.0.0.1:9000');
    (cause as unknown as { code: string }).code = 'ECONNREFUSED';
    const fetchErr = new TypeError('fetch failed');
    (fetchErr as unknown as { cause: Error }).cause = cause;
    globalThis.fetch = vi.fn(async () => {
      throw fetchErr;
    }) as unknown as typeof fetch;

    const result = await speechToTextLocal(Buffer.alloc(64));
    expect(result.text).toBe('');
    expect(result.error).toBeTruthy();
    expect(result.error).toMatch(/ECONNREFUSED|not running|unreachable/i);
    expect(result.error).toContain('http://127.0.0.1:9000');
  });

  it('translates bare "fetch failed" with no cause as server-down hint', async () => {
    process.env.WHISPER_SERVER_URL = 'http://127.0.0.1:9000';
    globalThis.fetch = vi.fn(async () => {
      throw new TypeError('fetch failed');
    }) as unknown as typeof fetch;

    const result = await speechToTextLocal(Buffer.alloc(64));
    expect(result.error).toMatch(/not responding|not running/i);
    expect(result.error).toContain('http://127.0.0.1:9000');
  });

  it('translates timeout abort into try-shorter-clip hint', async () => {
    process.env.WHISPER_SERVER_URL = 'http://127.0.0.1:9000';
    const abortErr = new Error('The operation was aborted due to timeout');
    abortErr.name = 'AbortError';
    globalThis.fetch = vi.fn(async () => {
      throw abortErr;
    }) as unknown as typeof fetch;

    const result = await speechToTextLocal(Buffer.alloc(64));
    expect(result.error).toMatch(/aborted|shorter|>90s/i);
  });

  it('preserves URL in the message even for unrecognised errors', async () => {
    process.env.WHISPER_SERVER_URL = 'http://example:7777';
    globalThis.fetch = vi.fn(async () => {
      throw new Error('some weird error');
    }) as unknown as typeof fetch;

    const result = await speechToTextLocal(Buffer.alloc(64));
    expect(result.error).toContain('http://example:7777');
    expect(result.error).toContain('some weird error');
  });
});
