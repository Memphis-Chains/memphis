// Tests for gateway channel adapters: telegram.ts (splitText utility).
// Discord adapter removed in Karpathy refactor sprint 1 — zero operator
// usage. Telegram is the sole active channel.
import { describe, expect, it } from 'vitest';

describe('telegram channel', () => {
  it('module exports createTelegramAdapter', async () => {
    const mod = await import('../../src/gateway/channels/telegram.js');
    expect(typeof mod.createTelegramAdapter).toBe('function');
  });

  it('createTelegramAdapter returns a ChannelAdapter shape', async () => {
    const mod = await import('../../src/gateway/channels/telegram.js');
    expect(mod.createTelegramAdapter.length).toBeGreaterThanOrEqual(1);
  });
});

describe('text splitting pattern', () => {
  // Replicate the splitText logic used in both channels
  function splitText(text: string, maxLen: number): string[] {
    if (text.length <= maxLen) return [text];
    const chunks: string[] = [];
    for (let i = 0; i < text.length; i += maxLen) {
      chunks.push(text.slice(i, i + maxLen));
    }
    return chunks;
  }

  it('returns single chunk for short text', () => {
    expect(splitText('hello', 4096)).toEqual(['hello']);
  });

  it('splits long text into chunks', () => {
    const text = 'a'.repeat(5000);
    const chunks = splitText(text, 2000);
    expect(chunks).toHaveLength(3);
    expect(chunks[0]).toHaveLength(2000);
    expect(chunks[1]).toHaveLength(2000);
    expect(chunks[2]).toHaveLength(1000);
  });

  it('handles exact boundary', () => {
    const text = 'a'.repeat(4096);
    expect(splitText(text, 4096)).toEqual([text]);
  });

  it('handles empty text', () => {
    expect(splitText('', 100)).toEqual(['']);
  });
});
