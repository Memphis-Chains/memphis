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
 * Run ffmpeg without blocking the event loop. Codex P1 #431 caught
 * that `execSync` here stalls all Telegram traffic until transcode
 * finishes — a few longer voice clips make the bot appear frozen
 * to other chats. `execFile` with promisified wait runs the same
 * subprocess but yields to the event loop while it's working.
 *
 * Args are passed as an array (not a shell string) so the input
 * filename can't break out via shell metacharacters.
 */
async function runFfmpegAsync(inputFile: string, outputFile: string): Promise<void> {
  const { execFile } = await import('child_process');
  const { promisify } = await import('util');
  const execFileAsync = promisify(execFile);
  await execFileAsync(
    'ffmpeg',
    ['-y', '-i', inputFile, '-ar', '16000', '-ac', '1', '-c:a', 'pcm_s16le', outputFile],
    { timeout: 30_000 },
  );
}

/**
 * Convert OGG/OPUS audio to WAV 16kHz mono using ffmpeg, then send to whisper-server.
 */
export async function speechToTextLocal(audioBuffer: Buffer): Promise<SttResult> {
  const fs = await import('fs');
  const path = await import('path');
  const os = await import('os');

  const tmpDir = os.tmpdir();
  const inputFile = path.join(tmpDir, `voice_input_${Date.now()}.ogg`);
  const outputFile = path.join(tmpDir, `voice_output_${Date.now()}.wav`);

  try {
    // Write input audio
    fs.writeFileSync(inputFile, audioBuffer);

    // Convert OGG → WAV (16kHz, mono) for whisper. Async so the event
    // loop keeps serving Telegram updates while ffmpeg is working.
    await runFfmpegAsync(inputFile, outputFile);

    const wavBuffer = fs.readFileSync(outputFile);

    // Send to whisper-server (faster-whisper or whisper.cpp HTTP service)
    const response = await fetch(whisperServerInferUrl(), {
      method: 'POST',
      headers: { 'Content-Type': 'audio/wav' },
      body: new Uint8Array(wavBuffer),
      // 90s timeout — `medium` whisper model on CPU fallback or longer
      // recordings (>30s of audio) routinely takes >30s to transcribe;
      // operator session 2026-05-05 hit "operation aborted due to
      // timeout" with the 30s budget. CUDA-backed runs finish in
      // 1-3s for normal voice notes, so 90s is generous-but-bounded
      // — we still abort genuinely-stuck requests.
      signal: AbortSignal.timeout(90000),
    });

    if (!response.ok) {
      const errText = await response.text();
      log.warn({ status: response.status, errText }, 'Local whisper STT failed');
      return { text: '', error: `Whisper server error (${response.status}): ${errText.slice(0, 200)}` };
    }

    const result = (await response.json()) as { text?: string; transcription?: string };
    const text = result.text ?? result.transcription ?? '';

    // Codex P2 #431: don't log transcription text at info level. Voice
    // input can carry sensitive PII (names, addresses, account numbers
    // dictated to the bot). The metadata-only signal is enough — bytes
    // transcribed proves the path worked without leaking the content
    // into routine log sinks. Drop to debug + replace text with length.
    log.debug({ chars: text.length }, 'Local whisper STT success');
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