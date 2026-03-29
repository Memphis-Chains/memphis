/**
 * Tests for interactive chat runtime convergence.
 * Proves that interactive chat requires canonical runtime deps
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

describe('interactive chat runtime convergence', () => {
  it('canonical mode: warns when starting without chatProvider', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const options: InteractiveChatOptions = {
      orchestration: {
        generate: vi.fn(),
        providersHealth: vi.fn(async () => []),
      } as never,
      provider: 'auto',
    };

    // The function creates a readline interface and blocks on input.
    // Verify it shows degradation warning instead of throwing.
    const result = await Promise.race([
      runInteractiveChat(options).then(() => 'completed'),
      new Promise<string>((resolve) => setTimeout(() => resolve('waiting-for-input'), 50)),
    ]);

    expect(result).toBe('waiting-for-input');
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('degraded mode'));
    warnSpy.mockRestore();
  });

  it('provider-only mode: starts without chatProvider', async () => {
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
      } as never,
      provider: 'auto',
      providerOnly: true,
    };

    // The function creates a readline interface and blocks on input.
    // We verify it doesn't throw the "requires a runtime provider" error
    // by racing with a short timeout.
    const result = await Promise.race([
      runInteractiveChat(options).then(() => 'completed'),
      new Promise<string>((resolve) => setTimeout(() => resolve('waiting-for-input'), 50)),
    ]);

    expect(result).toBe('waiting-for-input');
  });
});
