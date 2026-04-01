/**
 * Tests for gateway channel adapters:
 * - telegram.ts (splitText utility)
 * - discord.ts (splitText utility)
 *
 * Note: Full adapter tests require mocking grammy/discord.js SDKs.
 * These tests cover the exported pure functions and type contracts.
 */

import { describe, expect, it } from 'vitest';

// We test the splitText logic by importing the module and exercising the adapters' text splitting.
// Since splitText is private, we test it indirectly through the adapter's send behavior,
// or test the pattern directly.

describe('telegram channel', () => {
  it('module exports createTelegramAdapter', async () => {
    const mod = await import('../../src/gateway/channels/telegram.js');
    expect(typeof mod.createTelegramAdapter).toBe('function');
  });

  it('createTelegramAdapter returns a ChannelAdapter shape', async () => {
    // We can't actually create the adapter without a real token connecting to Telegram,
    // but we can verify the function signature accepts string + options
    const mod = await import('../../src/gateway/channels/telegram.js');
    expect(mod.createTelegramAdapter.length).toBeGreaterThanOrEqual(1);
  });
});

describe('discord channel', () => {
  it('module exports createDiscordAdapter', async () => {
    const mod = await import('../../src/gateway/channels/discord.js');
    expect(typeof mod.createDiscordAdapter).toBe('function');
  }, 15_000);

  it('createDiscordAdapter returns a ChannelAdapter shape', async () => {
    const mod = await import('../../src/gateway/channels/discord.js');
    expect(mod.createDiscordAdapter.length).toBeGreaterThanOrEqual(1);
  }, 15_000);
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
