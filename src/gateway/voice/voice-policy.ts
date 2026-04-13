/**
 * Per-chat voice policy for Sprint 9.
 *
 * Two responsibilities:
 * 1. Per-chat enable/disable toggle for outbound TTS replies. Operators
 *    flip this with `/voice on|off` from Telegram.
 * 2. Daily TTS quota per chat — `MEMPHIS_TTS_DAILY_CHAT_LIMIT`
 *    utterances/chat/day. TTS calls are paid (HF Inference / Google
 *    Cloud); the governor stops a chatty chat from running up the bill.
 *
 * State lives in-process — Telegram bot restart resets the toggles and
 * the daily counters. Operators that want durable preferences should
 * record them in `.env` defaults rather than `/voice`.
 */

export const DEFAULT_TTS_DAILY_CHAT_LIMIT = 100;

export type VoicePreference = 'on' | 'off';

interface ChatVoiceState {
  preference: VoicePreference;
  dayKey: string;
  ttsCallsToday: number;
}

const chatStates = new Map<string, ChatVoiceState>();

function todayKey(now: Date = new Date()): string {
  return `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}-${String(now.getUTCDate()).padStart(2, '0')}`;
}

function readDailyLimit(rawEnv: NodeJS.ProcessEnv): number {
  const raw = rawEnv.MEMPHIS_TTS_DAILY_CHAT_LIMIT?.trim();
  if (!raw) return DEFAULT_TTS_DAILY_CHAT_LIMIT;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed < 0) return DEFAULT_TTS_DAILY_CHAT_LIMIT;
  return parsed;
}

function ensureState(chatId: string, now: Date): ChatVoiceState {
  const dayKey = todayKey(now);
  const existing = chatStates.get(chatId);
  if (!existing) {
    const fresh: ChatVoiceState = { preference: 'on', dayKey, ttsCallsToday: 0 };
    chatStates.set(chatId, fresh);
    return fresh;
  }
  if (existing.dayKey !== dayKey) {
    existing.dayKey = dayKey;
    existing.ttsCallsToday = 0;
  }
  return existing;
}

export function getVoicePreference(chatId: string, now: Date = new Date()): VoicePreference {
  return ensureState(chatId, now).preference;
}

export function setVoicePreference(
  chatId: string,
  preference: VoicePreference,
  now: Date = new Date(),
): VoicePreference {
  const state = ensureState(chatId, now);
  state.preference = preference;
  return state.preference;
}

export interface QuotaCheck {
  allowed: boolean;
  used: number;
  limit: number;
  remaining: number;
  reason?: 'preference_off' | 'daily_limit_reached' | 'limit_disabled';
}

/**
 * Read-only quota check — does not consume. Use `consumeTtsQuota` to
 * actually decrement after a successful TTS call.
 */
export function checkTtsQuota(
  chatId: string,
  rawEnv: NodeJS.ProcessEnv = process.env,
  now: Date = new Date(),
): QuotaCheck {
  const state = ensureState(chatId, now);
  const limit = readDailyLimit(rawEnv);
  if (state.preference === 'off') {
    return {
      allowed: false,
      used: state.ttsCallsToday,
      limit,
      remaining: Math.max(0, limit - state.ttsCallsToday),
      reason: 'preference_off',
    };
  }
  if (limit === 0) {
    return {
      allowed: false,
      used: state.ttsCallsToday,
      limit,
      remaining: 0,
      reason: 'limit_disabled',
    };
  }
  if (state.ttsCallsToday >= limit) {
    return {
      allowed: false,
      used: state.ttsCallsToday,
      limit,
      remaining: 0,
      reason: 'daily_limit_reached',
    };
  }
  return {
    allowed: true,
    used: state.ttsCallsToday,
    limit,
    remaining: limit - state.ttsCallsToday,
  };
}

/**
 * Increment the counter — call after a TTS request returns. Returns the
 * post-increment usage snapshot.
 */
export function consumeTtsQuota(
  chatId: string,
  rawEnv: NodeJS.ProcessEnv = process.env,
  now: Date = new Date(),
): QuotaCheck {
  const state = ensureState(chatId, now);
  state.ttsCallsToday += 1;
  return checkTtsQuota(chatId, rawEnv, now);
}

/** Test-only reset. */
export function resetVoicePolicy(): void {
  chatStates.clear();
}
