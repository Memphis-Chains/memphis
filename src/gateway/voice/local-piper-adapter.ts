/**
 * Local TTS adapter — routes synthesized speech through a host-side
 * Piper HTTP server on `PIPER_SERVER_URL` (default
 * `http://localhost:5500`). Mirrors the shape of `local-whisper-adapter.ts`
 * so the chooser in `voice-service.ts:textToSpeech` switches engines
 * with a single boolean.
 *
 * Sprint H Phase 1 voice stack decision (2026-05-04) picked Piper
 * `pl_PL-gosia-medium.onnx` (~80 MB CPU-only, <100 ms latency,
 * ONNX-backed). See `docs/dev/voice-stack-decision-2026-05-04.md`
 * for rationale and `docs/operator/voice-local-tts.md` for the
 * install runbook (Piper binary + voice files + minimal HTTP server).
 *
 * Routing into this adapter is gated by `MEMPHIS_VOICE_MODE` — see
 * `voice-service.ts:resolveVoiceConfig`. This module stays pure
 * (no env-routing logic) so it can be called directly from tests
 * / scripts without the chooser.
 */

import { LOG_LEVEL, PIPER_SERVER_URL } from '../../config/env-registry.js';
import { createPinoLogger } from '../../infra/logging/pino.js';

const log = createPinoLogger({ level: LOG_LEVEL.read(process.env) });

export interface TtsResult {
  audio: Buffer;
  contentType: string;
  error?: string;
}

function piperServerSynthesizeUrl(): string {
  // Convention follows the `wyoming` / Piper HTTP wrappers most operators
  // use: POST `/api/tts` with text body returns the synthesized audio.
  // The runbook in `docs/operator/voice-local-tts.md` ships a minimal
  // server matching this shape.
  return `${PIPER_SERVER_URL.read(process.env)}/api/tts`;
}

/**
 * Send `text` to the local Piper HTTP server, return the audio buffer.
 * Failure modes (timeout, server unreachable, non-200 response) surface
 * as `{ audio: empty, contentType: '', error }` — same shape as the
 * cloud TTS path so callers don't branch on engine.
 *
 * Audio format: WAV (PCM 16-bit) or OGG/Opus depending on the Piper
 * server's encode flag. The server runbook pins WAV for predictability;
 * Telegram tolerates WAV via `sendVoice()` if the buffer is small.
 */
export async function textToSpeechLocal(text: string): Promise<TtsResult> {
  const url = piperServerSynthesizeUrl();
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain' },
      body: text,
      signal: AbortSignal.timeout(15_000),
    });

    if (!response.ok) {
      const errText = await response.text();
      log.warn({ status: response.status, errText }, 'Local Piper TTS failed');
      return {
        audio: Buffer.alloc(0),
        contentType: '',
        error: `Piper server error (${response.status}): ${errText.slice(0, 200)}`,
      };
    }

    const contentType = response.headers.get('content-type') ?? 'audio/wav';
    const arrayBuf = await response.arrayBuffer();
    const audio = Buffer.from(arrayBuf);
    log.debug({ bytes: audio.length, contentType }, 'Local Piper TTS success');
    return { audio, contentType };
  } catch (err) {
    log.error({ err }, 'Local Piper TTS error');
    return {
      audio: Buffer.alloc(0),
      contentType: '',
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

/**
 * Liveness probe for the Piper server. Used by the doctor surface
 * (Sprint H PR-C `ta12-voice-stack`) to flag misconfigured TTS
 * before the operator hits a live demo with a dead engine.
 */
export async function checkPiperServerHealth(): Promise<{
  ok: boolean;
  latencyMs?: number;
  error?: string;
}> {
  const start = Date.now();
  try {
    const response = await fetch(PIPER_SERVER_URL.read(process.env), {
      signal: AbortSignal.timeout(5000),
    });
    const latency = Date.now() - start;
    return { ok: response.ok, latencyMs: latency };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}
