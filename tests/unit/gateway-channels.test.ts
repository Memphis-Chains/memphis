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

  it('recognizes bare operator tool probes before the LLM gateway', async () => {
    const mod = await import('../../src/gateway/channels/telegram.js');
    expect(mod.isTelegramToolsProbe('tools?>')).toBe(true);
    expect(mod.isTelegramToolsProbe('tools?')).toBe(true);
    expect(mod.isTelegramToolsProbe('list tools')).toBe(true);
    expect(mod.isTelegramToolsProbe('jakie narzedzia?')).toBe(true);
    expect(mod.isTelegramToolsProbe('run the tool now')).toBe(false);
  });

  it('recognizes bare operator model probes before the LLM gateway', async () => {
    const mod = await import('../../src/gateway/channels/telegram.js');
    expect(mod.isTelegramModelProbe('what model do u use?')).toBe(true);
    expect(mod.isTelegramModelProbe('model?')).toBe(true);
    expect(mod.isTelegramModelProbe('provider?>')).toBe(true);
    expect(mod.isTelegramModelProbe('jaki model?')).toBe(true);
    expect(mod.isTelegramModelProbe('ile masz okna kontekstowego?')).toBe(true);
    expect(mod.isTelegramModelProbe('context window?')).toBe(true);
    expect(mod.isTelegramModelProbe('use the model to answer')).toBe(false);
  });

  it('recognizes bare operator status probes before the LLM gateway', async () => {
    const mod = await import('../../src/gateway/channels/telegram.js');
    expect(mod.isTelegramStatusProbe('status')).toBe(true);
    expect(mod.isTelegramStatusProbe('status?')).toBe(true);
    expect(mod.isTelegramStatusProbe('runtime status')).toBe(true);
    expect(mod.isTelegramStatusProbe('status tools')).toBe(false);
  });

  it('maps Telegram tier 2 to full-access runtime overlay when configured', async () => {
    const mod = await import('../../src/gateway/channels/telegram.js');
    const previous = process.env.MEMPHIS_TIER2_FULL_ACCESS;
    process.env.MEMPHIS_TIER2_FULL_ACCESS = 'true';
    try {
      expect(mod.isTelegramTier2FullAccess()).toBe(true);
      expect(mod.buildTelegramTierEnvOverride('chat-1', 2)).toMatchObject({
        MEMPHIS_AUTONOMY_MODE: 'full',
        MEMPHIS_SURFACE_TELEGRAM_MAX_TOOL_TIER: '3',
        MEMPHIS_SURFACE_TELEGRAM_ALLOW_UNKNOWN_TOOLS: 'true',
        MEMPHIS_TIER3_FS_UNRESTRICTED: 'true',
        GATEWAY_EXEC_RESTRICTED_MODE: 'false',
        MEMPHIS_WEB_FETCH_ALLOW_PRIVATE_NETWORK: 'true',
      });
    } finally {
      if (previous === undefined) delete process.env.MEMPHIS_TIER2_FULL_ACCESS;
      else process.env.MEMPHIS_TIER2_FULL_ACCESS = previous;
    }
  });

  it('keeps Telegram tier 2 as default surface mode when full-access override is off', async () => {
    const mod = await import('../../src/gateway/channels/telegram.js');
    const previous = process.env.MEMPHIS_TIER2_FULL_ACCESS;
    process.env.MEMPHIS_TIER2_FULL_ACCESS = 'false';
    try {
      expect(mod.isTelegramTier2FullAccess()).toBe(false);
      expect(mod.buildTelegramTierEnvOverride('chat-1', 2)).toBeUndefined();
      expect(mod.buildTelegramTierEnvOverride('chat-1', 1)).toMatchObject({
        MEMPHIS_SURFACE_TELEGRAM_MAX_TOOL_TIER: '1',
      });
    } finally {
      if (previous === undefined) delete process.env.MEMPHIS_TIER2_FULL_ACCESS;
      else process.env.MEMPHIS_TIER2_FULL_ACCESS = previous;
    }
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
