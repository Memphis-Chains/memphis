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

import { speechToTextLocal } from './local-whisper-adapter.js';
import { LOG_LEVEL, MEMPHIS_VOICE_MODE, WHISPER_SERVER_URL } from '../../config/env-registry.js';
import { readResolvedSecret } from '../../infra/config/vault-ref.js';
import { createPinoLogger } from '../../infra/logging/pino.js';

const log = createPinoLogger({ level: LOG_LEVEL.read(process.env) });

export type TtsProvider = 'huggingface' | 'google';

/**
 * Sprint H (PR-A) — voice stack mode chooser. The cloud path stays
 * the default for operators with a HuggingFace token; the local path
 * routes through faster-whisper / whisper.cpp on `WHISPER_SERVER_URL`.
 * Resolution priority (`MEMPHIS_VOICE_MODE`):
 *   - 'cloud'  — force HF API even if local server is running
 *   - 'local'  — force the on-host STT server even if HF token is set
 *   - 'auto'   — local if HF token is absent, cloud if present
 *
 * See `docs/dev/voice-stack-decision-2026-05-04.md` for the full
 * decision rationale + alternatives.
 */
export type VoiceMode = 'cloud' | 'local' | 'auto';

/** Resolved STT routing — `local` and `cloud` only; `auto` collapses to one. */
export type ResolvedVoiceRoute = 'cloud' | 'local';

export interface VoiceConfig {
  /** HF token may be empty when `route === 'local'`. */
  hfToken: string;
  sttModel: string;
  ttsModel: string;
  ttsProvider: TtsProvider;
  googleTtsApiKey?: string;
  /** Resolved STT route — chosen at config-load time per `MEMPHIS_VOICE_MODE`. */
  route: ResolvedVoiceRoute;
  /** Operator-set raw mode value, retained for status reporting / doctor output. */
  rawMode: VoiceMode;
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

  // Sprint H (PR-A) — chooser logic. Pre-Sprint-H this returned null
  // when HF token was absent, disabling voice entirely. Now `local`
  // mode lets the operator run a faster-whisper service on
  // WHISPER_SERVER_URL and skip the cloud token requirement.
  const rawMode = MEMPHIS_VOICE_MODE.read(rawEnv) as VoiceMode;
  const route: ResolvedVoiceRoute =
    rawMode === 'cloud'
      ? 'cloud'
      : rawMode === 'local'
        ? 'local'
        : hfToken
          ? 'cloud'
          : 'local';

  // Cloud route still needs the HF token. If operator picked 'cloud'
  // explicitly but the token is missing, voice is disabled — same
  // pre-Sprint-H behavior — rather than silently downgrading to
  // local. The doctor surface (Sprint H PR-C) flags this loudly.
  if (route === 'cloud' && !hfToken) return null;

  const ttsProvider = (rawEnv.MEMPHIS_TTS_PROVIDER?.trim()?.toLowerCase() ??
    'huggingface') as TtsProvider;
  const defaultTtsModel =
    ttsProvider === 'google' ? DEFAULT_TTS_MODEL_GOOGLE : DEFAULT_TTS_MODEL_HF;

  return {
    hfToken: hfToken ?? '',
    sttModel: rawEnv.MEMPHIS_STT_MODEL?.trim() || DEFAULT_STT_MODEL,
    ttsModel: rawEnv.MEMPHIS_TTS_MODEL?.trim() || defaultTtsModel,
    ttsProvider,
    googleTtsApiKey: googleKey ?? undefined,
    route,
    rawMode,
  };
}

// ─── STT ────────────────────────────────────────────────────────────────────

/**
 * Speech-to-text: routes through HuggingFace Whisper (cloud) or
 * faster-whisper / whisper.cpp on `WHISPER_SERVER_URL` (local) per
 * `config.route`. Accepts OGG/OPUS (Telegram voice), WAV, MP3, FLAC.
 */
export async function speechToText(audioBuffer: Buffer, config: VoiceConfig): Promise<SttResult> {
  if (config.route === 'local') {
    log.debug({ route: 'local', server: WHISPER_SERVER_URL.read(process.env) }, 'STT local route');
    return speechToTextLocal(audioBuffer);
  }

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
