/**
 * Voice service — speech-to-text and text-to-speech.
 *
 * STT: HuggingFace Inference API (Whisper) — supports Polish natively.
 * TTS: HuggingFace Inference API or Google Cloud TTS (fallback, free tier).
 *
 * Default models:
 *   STT: openai/whisper-large-v3
 *   TTS: facebook/mms-tts-pol (HuggingFace) or pl-PL-Standard-B (Google)
 *
 * Env vars:
 *   HUGGINGFACE_API_TOKEN  — required for STT, optional for TTS
 *   MEMPHIS_STT_MODEL      — override STT model
 *   MEMPHIS_TTS_MODEL      — override TTS model
 *   MEMPHIS_TTS_PROVIDER   — "huggingface" (default) or "google"
 *   GOOGLE_TTS_API_KEY     — required when TTS provider is "google"
 */

import { readResolvedSecret } from '../../infra/config/vault-ref.js';
import { createPinoLogger } from '../../infra/logging/pino.js';

const log = createPinoLogger({ level: process.env.LOG_LEVEL ?? 'info' });

export type TtsProvider = 'huggingface' | 'google';

export interface VoiceConfig {
  hfToken: string;
  sttModel: string;
  ttsModel: string;
  ttsProvider: TtsProvider;
  googleTtsApiKey?: string;
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
const DEFAULT_TTS_MODEL_HF = 'facebook/mms-tts-pol';
const DEFAULT_TTS_MODEL_GOOGLE = 'pl-PL-Standard-B';
const HF_INFERENCE_URL = 'https://api-inference.huggingface.co/models';
const GOOGLE_TTS_URL = 'https://texttospeech.googleapis.com/v1/text:synthesize';

export function resolveVoiceConfig(rawEnv: NodeJS.ProcessEnv = process.env): VoiceConfig | null {
  // Phase D1 (v1.7.1): same vault-ref filter as Telegram. If
  // HUGGINGFACE_API_TOKEN was set in .env as `VAULT:huggingface_api_token`
  // and the config layer couldn't expand it (vault locked, entry missing,
  // expand-time race), we'd otherwise ship the literal "VAULT:..." string
  // to api-inference.huggingface.co and get 401 on every voice request.
  const hfToken = readResolvedSecret(rawEnv.HUGGINGFACE_API_TOKEN);
  const googleKey = readResolvedSecret(rawEnv.GOOGLE_TTS_API_KEY);
  // Need at least HF token (for STT) to enable voice
  if (!hfToken) return null;

  const ttsProvider = (rawEnv.MEMPHIS_TTS_PROVIDER?.trim()?.toLowerCase() ??
    'huggingface') as TtsProvider;
  const defaultTtsModel =
    ttsProvider === 'google' ? DEFAULT_TTS_MODEL_GOOGLE : DEFAULT_TTS_MODEL_HF;

  return {
    hfToken,
    sttModel: rawEnv.MEMPHIS_STT_MODEL?.trim() || DEFAULT_STT_MODEL,
    ttsModel: rawEnv.MEMPHIS_TTS_MODEL?.trim() || defaultTtsModel,
    ttsProvider,
    googleTtsApiKey: googleKey ?? undefined,
  };
}

// ─── STT ────────────────────────────────────────────────────────────────────

/**
 * Speech-to-text: send audio bytes to HuggingFace Whisper.
 * Accepts OGG/OPUS (Telegram voice), WAV, MP3, FLAC.
 */
export async function speechToText(audioBuffer: Buffer, config: VoiceConfig): Promise<SttResult> {
  const model = config.sttModel;
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

// ─── TTS ────────────────────────────────────────────────────────────────────

/**
 * Text-to-speech: route to HuggingFace or Google Cloud TTS based on config.
 */
export async function textToSpeech(text: string, config: VoiceConfig): Promise<TtsResult> {
  if (config.ttsProvider === 'google' && config.googleTtsApiKey) {
    return googleTts(text, config);
  }
  return huggingfaceTts(text, config);
}

/** HuggingFace Inference API TTS */
async function huggingfaceTts(text: string, config: VoiceConfig): Promise<TtsResult> {
  const model = config.ttsModel;
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
      log.warn({ status: response.status, model, errText }, 'HF TTS request failed');
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
    log.error({ err, model }, 'HF TTS error');
    return {
      audio: Buffer.alloc(0),
      contentType: '',
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

/**
 * Google Cloud Text-to-Speech API (v1).
 * Free tier: 1M characters/month for standard voices, 1M bytes/month for WaveNet.
 * Returns OGG/OPUS — perfect for Telegram voice messages.
 */
async function googleTts(text: string, config: VoiceConfig): Promise<TtsResult> {
  const voiceName = config.ttsModel;
  // Extract language code from voice name (e.g. "pl-PL-Standard-B" → "pl-PL")
  const languageCode = voiceName.split('-').slice(0, 2).join('-') || 'pl-PL';

  const url = `${GOOGLE_TTS_URL}?key=${config.googleTtsApiKey}`;

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        input: { text },
        voice: { languageCode, name: voiceName, ssmlGender: 'NEUTRAL' },
        audioConfig: { audioEncoding: 'OGG_OPUS', speakingRate: 1.0 },
      }),
    });

    if (!response.ok) {
      const errText = await response.text();
      log.warn({ status: response.status, errText }, 'Google TTS request failed');
      return {
        audio: Buffer.alloc(0),
        contentType: '',
        error: `Google TTS failed (${response.status}): ${errText.slice(0, 200)}`,
      };
    }

    const result = (await response.json()) as { audioContent?: string };
    if (!result.audioContent) {
      return { audio: Buffer.alloc(0), contentType: '', error: 'Google TTS returned no audio' };
    }

    return {
      audio: Buffer.from(result.audioContent, 'base64'),
      contentType: 'audio/ogg',
    };
  } catch (err) {
    log.error({ err }, 'Google TTS error');
    return {
      audio: Buffer.alloc(0),
      contentType: '',
      error: err instanceof Error ? err.message : String(err),
    };
  }
}
