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

import {
  LOG_LEVEL,
  MEMPHIS_PIPER_HEALTH_TIMEOUT_MS,
  MEMPHIS_TTS_TIMEOUT_MS,
  PIPER_SERVER_URL,
} from '../../config/env-registry.js';
import { createPinoLogger } from '../../infra/logging/pino.js';

const log = createPinoLogger({ level: LOG_LEVEL.read(process.env) });

export interface TtsResult {
  audio: Buffer;
  contentType: string;
  error?: string;
}

/**
 * Resolve the synthesis URL by joining `PIPER_SERVER_URL` with
 * `/api/tts`. R1 caught raw string concatenation producing `//api/tts`
 * on trailing slash. R2 fixed via `new URL(path, base)` — but R3
 * caught that the absolute-path form REPLACES any base path segment
 * (`http://host:5500/piper` → `.../api/tts`, losing `/piper`), which
 * breaks reverse-proxy / path-prefix deployments.
 *
 * Resolution: parse the base, append `/api/tts` to its existing path
 * (collapsing any trailing slash). Both shapes work:
 *   - `http://localhost:5500/`        → `http://localhost:5500/api/tts`
 *   - `http://localhost:5500`         → `http://localhost:5500/api/tts`
 *   - `http://host/piper/`            → `http://host/piper/api/tts`
 *   - `http://host/piper`             → `http://host/piper/api/tts`
 */
function piperServerSynthesizeUrl(): string {
  // Convention follows the `wyoming` / Piper HTTP wrappers most operators
  // use: POST `/api/tts` with text body returns the synthesized audio.
  // The runbook in `docs/operator/voice-local-tts.md` ships a minimal
  // server matching this shape.
  const base = PIPER_SERVER_URL.read(process.env);
  const url = new URL(base);
  const trimmedPath = url.pathname.replace(/\/+$/, '');
  url.pathname = `${trimmedPath}/api/tts`;
  return url.toString();
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
  // Codex R4 #432: `new URL(invalidBase)` throws synchronously; if the
  // operator misconfigures `PIPER_SERVER_URL=localhost:5500` (no
  // scheme), the throw escapes as a rejected promise instead of the
  // documented `{audio:empty, error}` envelope, breaking callers
  // that branch on the result shape (Telegram TTS path, doctor).
  // Build the URL inside the try so the contract holds for every
  // failure mode.
  let url: string;
  try {
    url = piperServerSynthesizeUrl();
  } catch (err) {
    log.error({ err }, 'Invalid PIPER_SERVER_URL');
    return {
      audio: Buffer.alloc(0),
      contentType: '',
      error: `Invalid PIPER_SERVER_URL: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain' },
      body: text,
      // Phase 1.5.3: env-driven via MEMPHIS_TTS_TIMEOUT_MS (default 5 min,
      // was 45 s hardcode after the operator-session 2026-05-05 22:08/22:14
      // bump). Long replies on Sandy Bridge can run 60+ seconds.
      signal: AbortSignal.timeout(MEMPHIS_TTS_TIMEOUT_MS.read(process.env)),
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
 *
 * Probes `/api/tts` with GET (the same route synthesis uses; GET
 * doesn't trigger model load since Piper expects POST with body).
 * Codex P2 #432 caught that probing the server root produces false
 * 404s on minimal wrappers exposing only `/api/tts`. R2 caught that
 * OPTIONS produces 501 on Python `BaseHTTPRequestHandler` (the
 * wrapper our own runbook ships) since `do_OPTIONS` isn't defined.
 * GET works on the runbook (`do_GET` returns 200 for any path) and
 * on real Piper builds (typically 405 = "POST only" which still
 * proves the route exists). 200/204/405 are all acceptable signals.
 */
export async function checkPiperServerHealth(): Promise<{
  ok: boolean;
  latencyMs?: number;
  error?: string;
}> {
  const start = Date.now();
  try {
    const response = await fetch(piperServerSynthesizeUrl(), {
      method: 'GET',
      // Phase 1.5.3: env-driven via MEMPHIS_PIPER_HEALTH_TIMEOUT_MS
      // (default 30 s, was 5 s hardcode).
      signal: AbortSignal.timeout(MEMPHIS_PIPER_HEALTH_TIMEOUT_MS.read(process.env)),
    });
    const latency = Date.now() - start;
    // 200/204 = GET supported (runbook wrapper). 405 = "POST only"
    // (real Piper builds) — route exists, server up. Any 404 or 5xx
    // is a real signal the route is broken / wrapper doesn't expose
    // /api/tts.
    const ok = response.ok || response.status === 405;
    return { ok, latencyMs: latency };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}
