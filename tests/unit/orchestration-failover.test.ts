/**
 * Provider auto-failover on stream timeout — tests for the cascade-walk
 * behavior in OrchestrationService.chat() added 2026-05-11.
 *
 * Operator hit MiniMax stream timeouts on long-context turns (88k tokens,
 * 45s timeout) and had to manually switch DEFAULT_PROVIDER in .env +
 * reload. This module asserts that timeouts trigger automatic retry on
 * the next-in-cascade provider for the SAME turn, with audit emission +
 * response stamp.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { ProviderName } from '../../src/core/types.js';
import { OrchestrationService } from '../../src/modules/orchestration/service.js';
import type { RuntimeProvider } from '../../src/providers/runtime.js';

function createMockProvider(
  name: ProviderName,
  chatImpl?: RuntimeProvider['chat'],
): RuntimeProvider {
  return {
    name,
    isConfigured: () => true,
    isAvailable: async () => true,
    listModels: async () => [`${name}-model`],
    defaultModel: () => `${name}-model`,
    healthCheck: async () => ({ name, ok: true }),
    chat:
      chatImpl ??
      vi.fn(async () => ({
        content: `${name} reply`,
        model: `${name}-model`,
        tokens: { prompt: 10, completion: 5, total: 15 },
      })),
    generate: vi.fn(async () => ({
      id: 'test-id',
      providerUsed: name,
      output: `${name} reply`,
      timingMs: 100,
    })),
  };
}

describe('OrchestrationService.chat() — provider auto-failover', () => {
  const messages = [{ role: 'user' as const, content: 'hello' }];

  afterEach(() => {
    delete process.env.MEMPHIS_PROVIDER_AUTO_FAILOVER;
  });

  it('returns primary response without failover when no error', async () => {
    const minimax = createMockProvider('minimax');
    const anthropic = createMockProvider('anthropic');
    const orchestration = new OrchestrationService({
      defaultProvider: 'minimax',
      providers: [minimax, anthropic],
      cascadeOrder: ['minimax', 'anthropic'],
    });
    const result = await orchestration.chat({ messages, provider: 'minimax' });
    expect(result.providerUsed).toBe('minimax');
    expect(result.output).toBe('minimax reply');
    expect(result.output).not.toMatch(/failover/);
    expect(anthropic.chat).not.toHaveBeenCalled();
  });

  it('cascades to next provider when primary times out', async () => {
    const minimax = createMockProvider(
      'minimax',
      vi.fn(async () => {
        throw new Error('Network Error: timed out reading response');
      }),
    );
    const anthropic = createMockProvider('anthropic');
    const orchestration = new OrchestrationService({
      defaultProvider: 'minimax',
      providers: [minimax, anthropic],
      cascadeOrder: ['minimax', 'anthropic'],
    });
    const result = await orchestration.chat({ messages, provider: 'minimax' });
    expect(result.providerUsed).toBe('anthropic');
    expect(result.output).toContain('anthropic reply');
    expect(result.output).toContain('failover from minimax/timeout');
    expect(minimax.chat).toHaveBeenCalledTimes(1);
    expect(anthropic.chat).toHaveBeenCalledTimes(1);
  });

  it('recognizes ECONNRESET as timeout-like', async () => {
    const minimax = createMockProvider(
      'minimax',
      vi.fn(async () => {
        const err = new Error('socket hang up') as NodeJS.ErrnoException;
        err.code = 'ECONNRESET';
        throw err;
      }),
    );
    const anthropic = createMockProvider('anthropic');
    const orchestration = new OrchestrationService({
      defaultProvider: 'minimax',
      providers: [minimax, anthropic],
      cascadeOrder: ['minimax', 'anthropic'],
    });
    const result = await orchestration.chat({ messages, provider: 'minimax' });
    expect(result.providerUsed).toBe('anthropic');
    expect(result.output).toContain('failover from minimax');
  });

  it('does NOT failover on non-timeout errors (auth, validation, 400)', async () => {
    const minimax = createMockProvider(
      'minimax',
      vi.fn(async () => {
        throw new Error('Invalid API key — 401 Unauthorized');
      }),
    );
    const anthropic = createMockProvider('anthropic');
    const orchestration = new OrchestrationService({
      defaultProvider: 'minimax',
      providers: [minimax, anthropic],
      cascadeOrder: ['minimax', 'anthropic'],
    });
    await expect(
      orchestration.chat({ messages, provider: 'minimax' }),
    ).rejects.toThrow(/401/);
    expect(anthropic.chat).not.toHaveBeenCalled();
  });

  it('walks full cascade until one succeeds', async () => {
    const minimax = createMockProvider(
      'minimax',
      vi.fn(async () => {
        throw new Error('timed out');
      }),
    );
    const anthropic = createMockProvider(
      'anthropic',
      vi.fn(async () => {
        throw new Error('socket hang up');
      }),
    );
    const ollama = createMockProvider('ollama');
    const orchestration = new OrchestrationService({
      defaultProvider: 'minimax',
      providers: [minimax, anthropic, ollama],
      cascadeOrder: ['minimax', 'anthropic', 'ollama'],
    });
    const result = await orchestration.chat({ messages, provider: 'minimax' });
    expect(result.providerUsed).toBe('ollama');
    // Stamp records the IMMEDIATELY preceding failure (anthropic), not minimax.
    // This matches the per-attempt "from" tracking — operator sees the latest
    // failover chain, audit log has the full trail.
    expect(result.output).toContain('failover from anthropic');
  });

  it('throws last error when entire cascade times out', async () => {
    const failingChat = vi.fn(async () => {
      throw new Error('connection timed out');
    });
    const minimax = createMockProvider('minimax', failingChat);
    const anthropic = createMockProvider('anthropic', failingChat);
    const orchestration = new OrchestrationService({
      defaultProvider: 'minimax',
      providers: [minimax, anthropic],
      cascadeOrder: ['minimax', 'anthropic'],
    });
    await expect(
      orchestration.chat({ messages, provider: 'minimax' }),
    ).rejects.toThrow(/timed out/);
  });

  it('respects MEMPHIS_PROVIDER_AUTO_FAILOVER=0 — no cascade walk', async () => {
    process.env.MEMPHIS_PROVIDER_AUTO_FAILOVER = '0';
    const minimax = createMockProvider(
      'minimax',
      vi.fn(async () => {
        throw new Error('timed out');
      }),
    );
    const anthropic = createMockProvider('anthropic');
    const orchestration = new OrchestrationService({
      defaultProvider: 'minimax',
      providers: [minimax, anthropic],
      cascadeOrder: ['minimax', 'anthropic'],
    });
    await expect(
      orchestration.chat({ messages, provider: 'minimax' }),
    ).rejects.toThrow(/timed out/);
    expect(anthropic.chat).not.toHaveBeenCalled();
  });
});
