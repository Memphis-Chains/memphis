/**
 * Sprint H PR-B — Piper local TTS routing contract.
 *
 * Pin the routing semantics in `voice-service.ts:textToSpeech` for
 * the new local route added by PR-B:
 *
 *  - `config.route === 'local'` → calls Piper HTTP server on
 *    `PIPER_SERVER_URL`, never hits HuggingFace or Google.
 *  - `config.route === 'cloud'` + Google credentials → Google Cloud TTS.
 *  - `config.route === 'cloud'` + HF token only → HuggingFace MMS-TTS-Pol.
 *
 * Decision doc: `docs/dev/voice-stack-decision-2026-05-04.md`
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { resolveVoiceConfig, textToSpeech } from '../../src/gateway/voice/voice-service.js';

describe('TTS routing — voice-service.ts:textToSpeech', () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    fetchSpy = vi.spyOn(globalThis, 'fetch');
  });

  afterEach(() => {
    fetchSpy.mockRestore();
  });

  it('local route hits PIPER_SERVER_URL (default :5500/api/tts)', async () => {
    fetchSpy.mockResolvedValueOnce(
      new Response(Buffer.from([0x52, 0x49, 0x46, 0x46]), {
        status: 200,
        headers: { 'content-type': 'audio/wav' },
      }),
    );
    const config = resolveVoiceConfig({
      MEMPHIS_VOICE_MODE: 'local',
    } as NodeJS.ProcessEnv);
    const result = await textToSpeech('cześć', config!);
    expect(result.audio.length).toBeGreaterThan(0);
    expect(result.contentType).toBe('audio/wav');
    expect(fetchSpy).toHaveBeenCalledWith(
      expect.stringContaining('/api/tts'),
      expect.objectContaining({ method: 'POST' }),
    );
    // No HF / Google API leak when local was picked.
    const cloudCalls = fetchSpy.mock.calls.filter(([url]) =>
      typeof url === 'string' &&
      (url.includes('huggingface.co') || url.includes('googleapis.com')),
    );
    expect(cloudCalls).toHaveLength(0);
  });

  it('cloud route + Google key hits Google Cloud TTS', async () => {
    fetchSpy.mockResolvedValueOnce(
      new Response(JSON.stringify({ audioContent: Buffer.from('hello').toString('base64') }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );
    const config = resolveVoiceConfig({
      MEMPHIS_VOICE_MODE: 'cloud',
      HUGGINGFACE_API_TOKEN: 'hf_xxx',
      MEMPHIS_TTS_PROVIDER: 'google',
      GOOGLE_TTS_API_KEY: 'AIza_xxx',
    } as NodeJS.ProcessEnv);
    expect(config?.ttsProvider).toBe('google');
    const result = await textToSpeech('cześć', config!);
    expect(result.audio.length).toBeGreaterThan(0);
    expect(fetchSpy).toHaveBeenCalledWith(
      expect.stringContaining('texttospeech.googleapis.com'),
      expect.any(Object),
    );
  });

  it('cloud route + HF token only hits HuggingFace MMS-TTS', async () => {
    fetchSpy.mockResolvedValueOnce(
      new Response(Buffer.from([0x52, 0x49]), {
        status: 200,
        headers: { 'content-type': 'audio/wav' },
      }),
    );
    const config = resolveVoiceConfig({
      MEMPHIS_VOICE_MODE: 'cloud',
      HUGGINGFACE_API_TOKEN: 'hf_xxx',
    } as NodeJS.ProcessEnv);
    await textToSpeech('cześć', config!);
    expect(fetchSpy).toHaveBeenCalledWith(
      expect.stringContaining('api-inference.huggingface.co'),
      expect.any(Object),
    );
  });

  it('local TTS returns error envelope when Piper server unreachable (no throw)', async () => {
    fetchSpy.mockRejectedValueOnce(new Error('ECONNREFUSED'));
    const config = resolveVoiceConfig({
      MEMPHIS_VOICE_MODE: 'local',
    } as NodeJS.ProcessEnv);
    const result = await textToSpeech('test', config!);
    expect(result.audio.length).toBe(0);
    expect(result.error).toContain('ECONNREFUSED');
  });

  it('honors PIPER_SERVER_URL override', async () => {
    fetchSpy.mockResolvedValueOnce(
      new Response(Buffer.from([0x00]), { status: 200 }),
    );
    const config = resolveVoiceConfig({
      MEMPHIS_VOICE_MODE: 'local',
      PIPER_SERVER_URL: 'http://piper-host.lan:6000',
    } as NodeJS.ProcessEnv);
    // The chooser reads PIPER_SERVER_URL via env-registry, which uses
    // process.env at call time — set it explicitly here.
    const prev = process.env.PIPER_SERVER_URL;
    process.env.PIPER_SERVER_URL = 'http://piper-host.lan:6000';
    try {
      await textToSpeech('test', config!);
      expect(fetchSpy).toHaveBeenCalledWith(
        'http://piper-host.lan:6000/api/tts',
        expect.any(Object),
      );
    } finally {
      if (prev === undefined) delete process.env.PIPER_SERVER_URL;
      else process.env.PIPER_SERVER_URL = prev;
    }
  });
});
