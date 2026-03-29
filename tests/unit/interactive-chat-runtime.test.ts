/**
 * Tests for interactive chat runtime convergence.
 * Proves that interactive chat resolves provider via cascade per-turn
 * and that provider-only mode is explicit.
 */

import { describe, expect, it, vi } from 'vitest';

const { runTurnRuntime } = vi.hoisted(() => ({
  runTurnRuntime: vi.fn(async () => ({
    provider: 'local-fallback',
    model: 'local-fallback-v0',
    timingMs: 5,
    output: 'canonical reply',
    messages: [],
    persistence: {
      sessionUpdated: true,
      memoryStoreAttempted: false,
      memoryStored: false,
      postResponseCognitiveAttempted: false,
      postResponseCognitiveOk: false,
      degraded: false,
      errors: [],
    },
  })),
}));

vi.mock('../../src/gateway/turn-runtime.js', () => ({
  runTurnRuntime,
}));

import { runInteractiveChat } from '../../src/infra/cli/interactive-chat.js';
import type { InteractiveChatOptions } from '../../src/infra/cli/interactive-chat.js';

function mockProvider(name = 'local-fallback') {
  return {
    name,
    isConfigured: () => true,
    isAvailable: async () => true,
    listModels: async () => [`${name}-v0`],
    defaultModel: () => `${name}-v0`,
    chat: vi.fn(),
    generate: vi.fn(),
  };
}

describe('interactive chat runtime convergence', () => {
  it('canonical mode: resolves provider via cascade (no chatProvider needed)', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const provider = mockProvider();
    const options: InteractiveChatOptions = {
      orchestration: {
        generate: vi.fn(),
        providersHealth: vi.fn(async () => []),
        getCascadeResult: vi.fn(() => ({
          provider,
          degraded: false,
          tier: 1 as const,
          originalRequested: 'auto',
          actualProvider: 'local-fallback',
        })),
      } as never,
      provider: 'auto',
    };

    const result = await Promise.race([
      runInteractiveChat(options).then(() => 'completed'),
      new Promise<string>((resolve) => setTimeout(() => resolve('waiting-for-input'), 50)),
    ]);

    expect(result).toBe('waiting-for-input');
    // Should NOT warn about degradation when cascade tier 1 succeeds
    expect(warnSpy).not.toHaveBeenCalled();
    logSpy.mockRestore();
    warnSpy.mockRestore();
  });

  it('canonical mode: shows degradation warning when cascade degrades', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const provider = mockProvider('ollama');
    const options: InteractiveChatOptions = {
      orchestration: {
        generate: vi.fn(),
        providersHealth: vi.fn(async () => []),
        getCascadeResult: vi.fn(() => ({
          provider,
          degraded: true,
          tier: 3 as const,
          originalRequested: 'deepseek',
          actualProvider: 'ollama',
          reason: 'deepseek in cooldown',
        })),
      } as never,
      provider: 'deepseek' as never,
    };

    const result = await Promise.race([
      runInteractiveChat(options).then(() => 'completed'),
      new Promise<string>((resolve) => setTimeout(() => resolve('waiting-for-input'), 50)),
    ]);

    expect(result).toBe('waiting-for-input');
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('degraded'));
    logSpy.mockRestore();
    warnSpy.mockRestore();
  });

  it('provider-only mode: starts without cascade (uses orchestration.generate)', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const options: InteractiveChatOptions = {
      orchestration: {
        generate: vi.fn(async () => ({
          id: 'gen_1',
          providerUsed: 'local-fallback',
          modelUsed: 'local-fallback-v0',
          output: 'reply',
          timingMs: 1,
        })),
        providersHealth: vi.fn(async () => []),
        getCascadeResult: vi.fn(),
      } as never,
      provider: 'auto',
      providerOnly: true,
    };

    const result = await Promise.race([
      runInteractiveChat(options).then(() => 'completed'),
      new Promise<string>((resolve) => setTimeout(() => resolve('waiting-for-input'), 50)),
    ]);

    expect(result).toBe('waiting-for-input');
    // getCascadeResult should NOT be called in provider-only mode
    expect(
      (options.orchestration as { getCascadeResult: ReturnType<typeof vi.fn> }).getCascadeResult,
    ).not.toHaveBeenCalled();
    logSpy.mockRestore();
  });
});
