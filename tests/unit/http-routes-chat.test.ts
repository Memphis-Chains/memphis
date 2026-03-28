/**
 * Tests for chat HTTP route (src/infra/http/routes/chat.ts).
 * Validates the registerChatRoutes function shape and schema validation.
 */

import { describe, expect, it, vi } from 'vitest';

const { runTurnRuntime } = vi.hoisted(() => ({
  runTurnRuntime: vi.fn(async () => ({
    provider: 'local-fallback',
    model: 'local-fallback-v0',
    timingMs: 7,
    output: 'runtime reply',
    messages: [],
    persistence: {
      sessionUpdated: true,
      memoryStoreAttempted: true,
      memoryStored: true,
      postResponseCognitiveAttempted: true,
      postResponseCognitiveOk: true,
      degraded: false,
      errors: [],
    },
  })),
}));

vi.mock('../../src/gateway/turn-runtime.js', () => ({
  runTurnRuntime,
}));

import { registerChatRoutes } from '../../src/infra/http/routes/chat.js';

describe('registerChatRoutes', () => {
  it('is a function that registers POST /v1/chat/generate', async () => {
    expect(typeof registerChatRoutes).toBe('function');

    const routes: Array<{ method: string; path: string }> = [];
    const mockApp = {
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      post: (path: string, _handler: (...args: unknown[]) => unknown) => {
        routes.push({ method: 'POST', path });
      },
    };

    const mockOrchestration = {} as Parameters<typeof registerChatRoutes>[1];
    await registerChatRoutes(mockApp as never, mockOrchestration);

    expect(routes).toHaveLength(1);
    expect(routes[0].path).toBe('/v1/chat/generate');
  });

  it('handler rejects invalid payloads', async () => {
    let registeredHandler: (...args: unknown[]) => unknown | undefined;
    const mockApp = {
      post: (_path: string, handler: (...args: unknown[]) => unknown) => {
        registeredHandler = handler;
      },
    };

    const mockOrchestration = {
      generate: async () => ({}),
    } as Parameters<typeof registerChatRoutes>[1];

    await registerChatRoutes(mockApp as never, mockOrchestration);
    expect(registeredHandler).toBeDefined();

    // Call with invalid body — should throw validation error
    try {
      await registeredHandler!({ body: {}, id: 'req-1' });
      expect.unreachable('should have thrown');
    } catch (err: unknown) {
      expect((err as { code?: string }).code ?? (err as Error).message).toContain(
        'VALIDATION_ERROR',
      );
    }
  });

  it('uses the canonical turn runtime when runtime deps are provided', async () => {
    let registeredHandler: ((request: { body: unknown; id: string }) => Promise<unknown>) | undefined;
    const mockApp = {
      post: (_path: string, handler: (request: { body: unknown; id: string }) => Promise<unknown>) => {
        registeredHandler = handler;
      },
    };

    const mockOrchestration = {
      generate: vi.fn(async () => ({
        id: 'gen_legacy',
        providerUsed: 'local-fallback',
        modelUsed: 'local-fallback-v0',
        output: 'legacy',
        timingMs: 1,
      })),
      resolveRuntimeProvider: vi.fn(() => ({
        name: 'local-fallback',
        defaultModel: () => 'local-fallback-v0',
      })),
    } as unknown as Parameters<typeof registerChatRoutes>[1];

    await registerChatRoutes(
      mockApp as never,
      mockOrchestration,
      undefined,
      {
        memory: {
          recall: vi.fn(async () => ({ items: [] })),
          store: vi.fn(async () => undefined),
          isAvailable: vi.fn(() => true),
        },
        toolExecutor: {
          listTools: vi.fn(() => []),
          execute: vi.fn(async () => '{}'),
        },
      },
    );

    const result = await registeredHandler?.({
      id: 'req-2',
      body: { input: 'hello runtime', provider: 'auto' },
    });

    expect(runTurnRuntime).toHaveBeenCalledWith(
      expect.objectContaining({
        input: 'hello runtime',
        surface: 'http.chat.generate',
        memoryUserId: 'http:anonymous',
      }),
    );
    expect(mockOrchestration.generate).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      providerUsed: 'local-fallback',
      output: 'runtime reply',
    });
  });
});
