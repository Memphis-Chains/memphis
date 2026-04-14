import { describe, expect, it } from 'vitest';

import { providerToLlmClient } from '../../src/gateway/provider-adapter.js';

/**
 * Regression net for Codex P1 against PR #81: cognitive-mode tuning
 * (temperature/maxTokens) was only forwarded by `resolveLlm` in the
 * `options.provider` branch — when callers pre-built an `LlmClient` and
 * passed it via `options.llm` (chat-loop path), per-turn mode tuning was
 * dropped. The fix extends `LlmClient.complete` to accept per-call
 * temperature/maxTokens, and `providerToLlmClient` honors them as
 * overrides over construction-time defaults.
 *
 * This test pins that override semantic for the adapter — proves
 * `complete({temperature, maxTokens})` reaches the underlying provider
 * call regardless of construction defaults.
 */

interface CapturedChat {
  temperature?: number;
  maxTokens?: number;
}

function fakeProvider(): { chat: (...args: unknown[]) => Promise<unknown>; calls: CapturedChat[] } {
  const calls: CapturedChat[] = [];
  return {
    calls,
    async chat(_messages: unknown, options: CapturedChat) {
      calls.push({ temperature: options.temperature, maxTokens: options.maxTokens });
      return { content: '', model: 'fake', provider: 'fake' };
    },
  };
}

describe('providerToLlmClient — per-call mode tuning override', () => {
  it('uses construction-time defaults when no per-call values supplied', async () => {
    const provider = fakeProvider();
    const llm = providerToLlmClient(provider as never, {
      temperature: 0.4,
      maxTokens: 2048,
    });
    await llm.complete({ system: 'sys', messages: [] });
    expect(provider.calls[0]?.temperature).toBe(0.4);
    expect(provider.calls[0]?.maxTokens).toBe(2048);
  });

  it('per-call temperature overrides default', async () => {
    const provider = fakeProvider();
    const llm = providerToLlmClient(provider as never, {
      temperature: 0.4,
      maxTokens: 2048,
    });
    await llm.complete({
      system: 'sys',
      messages: [],
      temperature: 0.3,
    });
    expect(provider.calls[0]?.temperature).toBe(0.3);
    expect(provider.calls[0]?.maxTokens).toBe(2048);
  });

  it('per-call maxTokens overrides default', async () => {
    const provider = fakeProvider();
    const llm = providerToLlmClient(provider as never, {
      temperature: 0.4,
      maxTokens: 2048,
    });
    await llm.complete({
      system: 'sys',
      messages: [],
      maxTokens: 1024,
    });
    expect(provider.calls[0]?.temperature).toBe(0.4);
    expect(provider.calls[0]?.maxTokens).toBe(1024);
  });

  it('per-call values land when no construction defaults set', async () => {
    const provider = fakeProvider();
    const llm = providerToLlmClient(provider as never);
    await llm.complete({
      system: 'sys',
      messages: [],
      temperature: 0.3,
      maxTokens: 1024,
    });
    expect(provider.calls[0]?.temperature).toBe(0.3);
    expect(provider.calls[0]?.maxTokens).toBe(1024);
  });
});
