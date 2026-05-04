/**
 * Local STT adapter — routes audio through a host-side STT server on
 * `WHISPER_SERVER_URL` (default `http://localhost:9000`). Compatible
 * with both `whisper.cpp`'s built-in `whisper-server` and
 * `faster-whisper`'s `python -m faster_whisper.server` HTTP wrapper.
 *
 * Sprint H Phase 1 voice stack decision (2026-05-04) picked
 * faster-whisper `medium` INT8 (~1.2 GB VRAM, 6× faster than vanilla
 * Whisper, Polish-tuned) as the recommended local engine. See
 * `docs/dev/voice-stack-decision-2026-05-04.md` for rationale, and
 * `docs/operator/voice-local-stt.md` for the install runbook.
 *
 * Routing into this adapter is gated by `MEMPHIS_VOICE_MODE` — see
 * `voice-service.ts:resolveVoiceConfig`. This module stays pure
 * (no env-routing logic) so it can also be called directly from
 * tests / scripts without the chooser.
 */

import { LOG_LEVEL, WHISPER_SERVER_URL } from '../../config/env-registry.js';
import { createPinoLogger } from '../../infra/logging/pino.js';

const log = createPinoLogger({ level: LOG_LEVEL.read(process.env) });

export interface SttResult {
  text: string;
  error?: string;
}

function whisperServerInferUrl(): string {
  return `${WHISPER_SERVER_URL.read(process.env)}/inference`;
}

// ─── STT ────────────────────────────────────────────────────────────────────

/**
 * Convert OGG/OPUS audio to WAV 16kHz mono using ffmpeg, then send to whisper-server.
 */
export async function speechToTextLocal(audioBuffer: Buffer): Promise<SttResult> {
  const { execSync } = await import('child_process');
  const fs = await import('fs');
  const path = await import('path');
  const os = await import('os');

  const tmpDir = os.tmpdir();
  const inputFile = path.join(tmpDir, `voice_input_${Date.now()}.ogg`);
  const outputFile = path.join(tmpDir, `voice_output_${Date.now()}.wav`);

  try {
    // Write input audio
    fs.writeFileSync(inputFile, audioBuffer);

    // Convert OGG → WAV (16kHz, mono) for whisper
    execSync(
      `ffmpeg -y -i "${inputFile}" -ar 16000 -ac 1 -c:a pcm_s16le "${outputFile}" 2>/dev/null`,
      { stdio: 'pipe' }
    );

    const wavBuffer = fs.readFileSync(outputFile);

    // Send to whisper-server (faster-whisper or whisper.cpp HTTP service)
    const response = await fetch(whisperServerInferUrl(), {
      method: 'POST',
      headers: { 'Content-Type': 'audio/wav' },
      body: new Uint8Array(wavBuffer),
      signal: AbortSignal.timeout(30000), // 30s timeout
    });

    if (!response.ok) {
      const errText = await response.text();
      log.warn({ status: response.status, errText }, 'Local whisper STT failed');
      return { text: '', error: `Whisper server error (${response.status}): ${errText.slice(0, 200)}` };
    }

    const result = (await response.json()) as { text?: string; transcription?: string };
    const text = result.text ?? result.transcription ?? '';
    
    log.info({ text: text.slice(0, 100) }, 'Local whisper STT success');
    return { text: text.trim() };

  } catch (err) {
    log.error({ err }, 'Local whisper STT error');
    return { text: '', error: err instanceof Error ? err.message : String(err) };
  } finally {
    // Cleanup temp files
    try {
      if (fs.existsSync(inputFile)) fs.unlinkSync(inputFile);
      if (fs.existsSync(outputFile)) fs.unlinkSync(outputFile);
    } catch {
      // ignore cleanup errors
    }
  }
}

// ─── Health check ──────────────────────────────────────────────────────────

export async function checkWhisperServerHealth(): Promise<{ ok: boolean; latencyMs?: number; error?: string }> {
  const start = Date.now();
  try {
    const response = await fetch(WHISPER_SERVER_URL.read(process.env), {
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