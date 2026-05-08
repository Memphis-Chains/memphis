/**
 * Audio adapter — reads an audio file from disk, transcribes it via
 * the existing whisper-server endpoint (Sprint H, :9000) and surfaces
 * a typed AudioTranscription.
 *
 * Reuses the same HTTP service voice messages already use. No new
 * whisper.cpp instance, no new model — just a different caller for
 * the existing pipeline.
 *
 * If the input isn't 16 kHz mono WAV, it's transcoded via ffmpeg
 * (same path as local-whisper-adapter for OGG/OPUS Telegram clips).
 */

import { execFile } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';


import type { AudioTranscription } from './types.js';
import { LOG_LEVEL, WHISPER_SERVER_URL } from '../../config/env-registry.js';
import { createPinoLogger } from '../../infra/logging/pino.js';

const log = createPinoLogger({ level: LOG_LEVEL.read(process.env) });

const STT_TIMEOUT_MS = 90_000;
const FFMPEG_TIMEOUT_MS = 30_000;

const execFileAsync = promisify(execFile);

/**
 * Determine whether the file is already in the whisper-server's
 * expected shape (WAV, 16 kHz, mono). Cheap heuristic: trust the
 * file extension. Real header inspection would require a parser
 * dependency; the failure mode of guessing wrong is "ffmpeg runs
 * unnecessarily" which is fine.
 */
function looksLikeWavInput(filePath: string): boolean {
  const ext = path.extname(filePath).toLowerCase();
  return ext === '.wav';
}

async function transcodeToWav(inputFile: string): Promise<string> {
  const tmpDir = os.tmpdir();
  const outputFile = path.join(tmpDir, `media_audio_${Date.now()}.wav`);
  await execFileAsync(
    'ffmpeg',
    ['-y', '-i', inputFile, '-ar', '16000', '-ac', '1', '-c:a', 'pcm_s16le', outputFile],
    { timeout: FFMPEG_TIMEOUT_MS },
  );
  return outputFile;
}

/**
 * Transcribe an audio file at `filePath`. Best-effort: returns an
 * AudioTranscription with `error` set on any failure rather than
 * throwing, so the orchestrator can keep the chain-write path
 * graceful.
 */
export async function transcribeAudioFile(
  filePath: string,
  rawEnv: NodeJS.ProcessEnv = process.env,
): Promise<AudioTranscription> {
  let wavPath: string | undefined;
  let createdTmp = false;
  try {
    wavPath = looksLikeWavInput(filePath) ? filePath : undefined;
    if (!wavPath) {
      wavPath = await transcodeToWav(filePath);
      createdTmp = true;
    }
    const wavBuffer = await fs.readFile(wavPath);
    const url = `${WHISPER_SERVER_URL.read(rawEnv).replace(/\/$/, '')}/inference`;

    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'audio/wav' },
      body: new Uint8Array(wavBuffer),
      signal: AbortSignal.timeout(STT_TIMEOUT_MS),
    });
    if (!response.ok) {
      const errText = await response.text().catch(() => '');
      log.warn(
        { status: response.status, errText: errText.slice(0, 200) },
        'media audio adapter: whisper-server non-OK',
      );
      return {
        kind: 'audio',
        text: '',
        // Adapter does not surface a top-level `error` field — the
        // type doesn't have one. Empty text + a log entry is the
        // signal; the orchestrator translates "" → no chain write.
      };
    }
    const result = (await response.json()) as {
      text?: string;
      transcription?: string;
      language?: string;
      duration_ms?: number;
    };
    return {
      kind: 'audio',
      text: (result.text ?? result.transcription ?? '').trim(),
      language: result.language,
      durationMs: result.duration_ms,
    };
  } catch (err) {
    log.warn(
      { err: err instanceof Error ? err.message : String(err) },
      'media audio adapter error',
    );
    return { kind: 'audio', text: '' };
  } finally {
    if (createdTmp && wavPath) {
      void fs.unlink(wavPath).catch(() => undefined);
    }
  }
}
