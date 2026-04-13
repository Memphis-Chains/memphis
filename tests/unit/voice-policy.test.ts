import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  DEFAULT_TTS_DAILY_CHAT_LIMIT,
  checkTtsQuota,
  consumeTtsQuota,
  getVoicePreference,
  resetVoicePolicy,
  setVoicePreference,
} from '../../src/gateway/voice/voice-policy.js';

const FIXED_DAY = new Date('2026-04-13T10:00:00Z');
const FIXED_NEXT_DAY = new Date('2026-04-14T01:00:00Z');

beforeEach(() => {
  resetVoicePolicy();
});

afterEach(() => {
  delete process.env.MEMPHIS_TTS_DAILY_CHAT_LIMIT;
});

describe('voice preference', () => {
  it('defaults to "on" for any new chat', () => {
    expect(getVoicePreference('chat-1', FIXED_DAY)).toBe('on');
  });

  it('honors a setVoicePreference("off")', () => {
    setVoicePreference('chat-1', 'off', FIXED_DAY);
    expect(getVoicePreference('chat-1', FIXED_DAY)).toBe('off');
  });

  it('keeps preferences isolated across chats', () => {
    setVoicePreference('chat-1', 'off', FIXED_DAY);
    expect(getVoicePreference('chat-2', FIXED_DAY)).toBe('on');
  });
});

describe('TTS quota', () => {
  it('is allowed on the first call with default limit', () => {
    const quota = checkTtsQuota('chat-1', process.env, FIXED_DAY);
    expect(quota.allowed).toBe(true);
    expect(quota.limit).toBe(DEFAULT_TTS_DAILY_CHAT_LIMIT);
    expect(quota.used).toBe(0);
    expect(quota.remaining).toBe(DEFAULT_TTS_DAILY_CHAT_LIMIT);
  });

  it('decrements after consume', () => {
    consumeTtsQuota('chat-1', process.env, FIXED_DAY);
    consumeTtsQuota('chat-1', process.env, FIXED_DAY);
    const quota = checkTtsQuota('chat-1', process.env, FIXED_DAY);
    expect(quota.used).toBe(2);
    expect(quota.remaining).toBe(DEFAULT_TTS_DAILY_CHAT_LIMIT - 2);
  });

  it('blocks once daily limit is reached', () => {
    process.env.MEMPHIS_TTS_DAILY_CHAT_LIMIT = '3';
    for (let i = 0; i < 3; i += 1) {
      consumeTtsQuota('chat-1', process.env, FIXED_DAY);
    }
    const quota = checkTtsQuota('chat-1', process.env, FIXED_DAY);
    expect(quota.allowed).toBe(false);
    expect(quota.reason).toBe('daily_limit_reached');
    expect(quota.used).toBe(3);
    expect(quota.remaining).toBe(0);
  });

  it('blocks when the chat preference is "off"', () => {
    setVoicePreference('chat-1', 'off', FIXED_DAY);
    const quota = checkTtsQuota('chat-1', process.env, FIXED_DAY);
    expect(quota.allowed).toBe(false);
    expect(quota.reason).toBe('preference_off');
  });

  it('blocks when MEMPHIS_TTS_DAILY_CHAT_LIMIT=0 (kill switch)', () => {
    process.env.MEMPHIS_TTS_DAILY_CHAT_LIMIT = '0';
    const quota = checkTtsQuota('chat-1', process.env, FIXED_DAY);
    expect(quota.allowed).toBe(false);
    expect(quota.reason).toBe('limit_disabled');
    expect(quota.limit).toBe(0);
  });

  it('falls back to default when env value is invalid', () => {
    process.env.MEMPHIS_TTS_DAILY_CHAT_LIMIT = 'banana';
    const quota = checkTtsQuota('chat-1', process.env, FIXED_DAY);
    expect(quota.limit).toBe(DEFAULT_TTS_DAILY_CHAT_LIMIT);
  });

  it('isolates counters per chat', () => {
    process.env.MEMPHIS_TTS_DAILY_CHAT_LIMIT = '5';
    for (let i = 0; i < 5; i += 1) {
      consumeTtsQuota('chat-1', process.env, FIXED_DAY);
    }
    expect(checkTtsQuota('chat-1', process.env, FIXED_DAY).allowed).toBe(false);
    expect(checkTtsQuota('chat-2', process.env, FIXED_DAY).allowed).toBe(true);
  });

  it('resets the counter at UTC midnight', () => {
    process.env.MEMPHIS_TTS_DAILY_CHAT_LIMIT = '3';
    for (let i = 0; i < 3; i += 1) {
      consumeTtsQuota('chat-1', process.env, FIXED_DAY);
    }
    expect(checkTtsQuota('chat-1', process.env, FIXED_DAY).allowed).toBe(false);

    const nextDay = checkTtsQuota('chat-1', process.env, FIXED_NEXT_DAY);
    expect(nextDay.allowed).toBe(true);
    expect(nextDay.used).toBe(0);
    expect(nextDay.remaining).toBe(3);
  });

  it('preference persists across day rollover', () => {
    setVoicePreference('chat-1', 'off', FIXED_DAY);
    const quota = checkTtsQuota('chat-1', process.env, FIXED_NEXT_DAY);
    expect(quota.allowed).toBe(false);
    expect(quota.reason).toBe('preference_off');
  });
});
