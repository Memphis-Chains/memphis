/**
 * Voice service — speech-to-text and text-to-speech via HuggingFace Inference API.
 *
 * Default models:
 *   STT: openai/whisper-large-v3 (supports Polish)
 *   TTS: facebook/mms-tts-pol (Polish MMS TTS)
 *
 * Override via env:
 *   MEMPHIS_STT_MODEL, MEMPHIS_TTS_MODEL, HUGGINGFACE_API_TOKEN
 */

import { createPinoLogger } from '../../infra/logging/pino.js';

const log = createPinoLogger({ level: process.env.LOG_LEVEL ?? 'info' });

export interface VoiceConfig {
  hfToken: string;
  sttModel?: string;
  ttsModel?: string;
}

export interface SttResult {
  text: string;
  error?: string;
}

export interface TtsResult {
  audio: Buffer;
  contentType: string;
  error?: string;
}

const DEFAULT_STT_MODEL = 'openai/whisper-large-v3';
const DEFAULT_TTS_MODEL = 'facebook/mms-tts-pol';
const HF_INFERENCE_URL = 'https://api-inference.huggingface.co/models';

export function resolveVoiceConfig(rawEnv: NodeJS.ProcessEnv = process.env): VoiceConfig | null {
  const hfToken = rawEnv.HUGGINGFACE_API_TOKEN?.trim();
  if (!hfToken) return null;
  return {
    hfToken,
    sttModel: rawEnv.MEMPHIS_STT_MODEL?.trim() || DEFAULT_STT_MODEL,
    ttsModel: rawEnv.MEMPHIS_TTS_MODEL?.trim() || DEFAULT_TTS_MODEL,
  };
}

/**
 * Speech-to-text: send audio bytes to HuggingFace Whisper.
 * Accepts OGG/OPUS (Telegram voice), WAV, MP3, FLAC.
 */
export async function speechToText(
  audioBuffer: Buffer,
  config: VoiceConfig,
): Promise<SttResult> {
  const model = config.sttModel ?? DEFAULT_STT_MODEL;
  const url = `${HF_INFERENCE_URL}/${model}`;

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${config.hfToken}`,
        'Content-Type': 'audio/ogg',
      },
      body: new Uint8Array(audioBuffer),
    });

    if (!response.ok) {
      const errText = await response.text();
      log.warn({ status: response.status, model, errText }, 'STT request failed');
      return { text: '', error: `STT failed (${response.status}): ${errText.slice(0, 200)}` };
    }

    const result = (await response.json()) as { text?: string };
    return { text: result.text?.trim() ?? '' };
  } catch (err) {
    log.error({ err, model }, 'STT error');
    return { text: '', error: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * Text-to-speech: send text to HuggingFace TTS model.
 * Returns audio buffer (typically WAV or FLAC depending on model).
 */
export async function textToSpeech(
  text: string,
  config: VoiceConfig,
): Promise<TtsResult> {
  const model = config.ttsModel ?? DEFAULT_TTS_MODEL;
  const url = `${HF_INFERENCE_URL}/${model}`;

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${config.hfToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ inputs: text }),
    });

    if (!response.ok) {
      const errText = await response.text();
      log.warn({ status: response.status, model, errText }, 'TTS request failed');
      return {
        audio: Buffer.alloc(0),
        contentType: '',
        error: `TTS failed (${response.status}): ${errText.slice(0, 200)}`,
      };
    }

    const contentType = response.headers.get('content-type') ?? 'audio/wav';
    const arrayBuf = await response.arrayBuffer();
    return { audio: Buffer.from(arrayBuf), contentType };
  } catch (err) {
    log.error({ err, model }, 'TTS error');
    return {
      audio: Buffer.alloc(0),
      contentType: '',
      error: err instanceof Error ? err.message : String(err),
    };
  }
}
