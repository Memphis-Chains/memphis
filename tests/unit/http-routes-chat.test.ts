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
    usage: { inputTokens: 12, outputTokens: 10, totalTokens: 22, estimated: true },
    telemetry: {
      usage: { inputTokens: 12, outputTokens: 10, totalTokens: 22, estimated: true },
      contextWindowTokens: 2048,
      estimatedPromptTokens: 24,
      remainingContextTokens: 2024,
      degraded: false,
    },
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

type RouteHandler = (
  request: { body: unknown; id: string; params?: Record<string, string | undefined> },
  reply: {
    status: (code: number) => { send: (payload: unknown) => unknown };
    send: (payload: unknown) => unknown;
  },
) => Promise<unknown>;

function makeReply() {
  return {
    status: () => ({
      send: (payload: unknown) => payload,
    }),
    send: (payload: unknown) => payload,
  };
}

describe('registerChatRoutes', () => {
  it('registers generate and async dispatch routes', async () => {
    expect(typeof registerChatRoutes).toBe('function');

    const routes: Array<{ method: string; path: string }> = [];
    const mockApp = {
      get: (path: string) => {
        routes.push({ method: 'GET', path });
      },
      post: (path: string) => {
        routes.push({ method: 'POST', path });
      },
    };

    const mockOrchestration = {} as Parameters<typeof registerChatRoutes>[1];
    await registerChatRoutes(mockApp as never, mockOrchestration);

    expect(routes).toEqual(
      expect.arrayContaining([
        { method: 'GET', path: '/v1/chat/dispatch/:workId' },
        { method: 'POST', path: '/v1/chat/dispatch' },
        { method: 'POST', path: '/v1/chat/generate' },
      ]),
    );
  });

  it('handler rejects invalid payloads', async () => {
    let registeredHandler: RouteHandler | undefined;
    const mockApp = {
      get: () => undefined,
      post: (path: string, handler: RouteHandler) => {
        if (path === '/v1/chat/generate') registeredHandler = handler;
      },
    };

    const mockOrchestration = {
      generate: async () => ({}),
    } as Parameters<typeof registerChatRoutes>[1];

    await registerChatRoutes(mockApp as never, mockOrchestration);
    expect(registeredHandler).toBeDefined();

    // Call with invalid body — should throw validation error
    try {
      await registeredHandler!({ body: {}, id: 'req-1' }, makeReply());
      expect.unreachable('should have thrown');
    } catch (err: unknown) {
      expect((err as { code?: string }).code ?? (err as Error).message).toContain(
        'VALIDATION_ERROR',
      );
    }
  });

  it('uses the canonical turn runtime when runtime deps are provided', async () => {
    let registeredHandler: RouteHandler | undefined;
    const mockApp = {
      get: () => undefined,
      post: (path: string, handler: RouteHandler) => {
        if (path === '/v1/chat/generate') registeredHandler = handler;
      },
    };

    const mockProvider = {
      name: 'local-fallback',
      defaultModel: () => 'local-fallback-v0',
    };

    const mockOrchestration = {
      generate: vi.fn(async () => ({
        id: 'gen_legacy',
        providerUsed: 'local-fallback',
        modelUsed: 'local-fallback-v0',
        output: 'legacy',
        timingMs: 1,
      })),
      resolveRuntimeProvider: vi.fn(() => mockProvider),
      getCascadeResult: vi.fn(() => ({
        provider: mockProvider,
        degraded: false,
        tier: 1 as const,
        originalRequested: 'auto',
        actualProvider: 'local-fallback',
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
    }, makeReply());

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
      usage: { totalTokens: 22, estimated: true },
      telemetry: { contextWindowTokens: 2048 },
      mode: 'canonical',
    });
  });

  it('canonical mode: returns 500 when runtime deps are missing (server misconfiguration)', async () => {
    let registeredHandler: RouteHandler | undefined;
    const mockApp = {
      get: () => undefined,
      post: (path: string, handler: RouteHandler) => {
        if (path === '/v1/chat/generate') registeredHandler = handler;
      },
    };

    const mockOrchestration = {
      generate: vi.fn(async () => ({
        id: 'gen_1',
        providerUsed: 'local-fallback',
        output: 'reply',
        timingMs: 1,
      })),
    } as unknown as Parameters<typeof registerChatRoutes>[1];

    // Register without runtime deps
    await registerChatRoutes(mockApp as never, mockOrchestration);

    try {
      await registeredHandler?.({
        id: 'req-3',
        body: { input: 'hello', provider: 'auto' },
      }, makeReply());
      expect.unreachable('should have thrown');
    } catch (err: unknown) {
      expect((err as { code?: string }).code).toBe('INTERNAL_ERROR');
      expect((err as { statusCode?: number }).statusCode).toBe(500);
    }
  });

  it('provider-only mode: uses orchestration.generate, not runTurnRuntime', async () => {
    runTurnRuntime.mockClear();
    let registeredHandler: RouteHandler | undefined;
    const mockApp = {
      get: () => undefined,
      post: (path: string, handler: RouteHandler) => {
        if (path === '/v1/chat/generate') registeredHandler = handler;
      },
    };

    const mockOrchestration = {
      generate: vi.fn(async () => ({
        id: 'gen_provider',
        providerUsed: 'local-fallback',
        modelUsed: 'local-fallback-v0',
        output: 'provider-only reply',
        usage: { inputTokens: 5, outputTokens: 6, totalTokens: 11, estimated: true },
        timingMs: 2,
      })),
    } as unknown as Parameters<typeof registerChatRoutes>[1];

    // Register without runtime deps — provider-only should still work
    await registerChatRoutes(mockApp as never, mockOrchestration);

    const result = await registeredHandler?.({
      id: 'req-4',
      body: { input: 'hello', provider: 'auto', mode: 'provider-only' },
    }, makeReply());

    expect(runTurnRuntime).not.toHaveBeenCalled();
    expect(mockOrchestration.generate).toHaveBeenCalled();
    expect(result).toMatchObject({
      providerUsed: 'local-fallback',
      output: 'provider-only reply',
      usage: { totalTokens: 11, estimated: true },
      telemetry: {
        usage: { totalTokens: 11 },
        contextWindowTokens: 2048,
      },
      mode: 'provider-only',
    });
  });

  it('default mode is canonical when mode field is omitted', async () => {
    let registeredHandler: RouteHandler | undefined;
    const mockApp = {
      get: () => undefined,
      post: (path: string, handler: RouteHandler) => {
        if (path === '/v1/chat/generate') registeredHandler = handler;
      },
    };

    const mockProvider = {
      name: 'local-fallback',
      defaultModel: () => 'local-fallback-v0',
    };

    const mockOrchestration = {
      generate: vi.fn(),
      resolveRuntimeProvider: vi.fn(() => mockProvider),
      getCascadeResult: vi.fn(() => ({
        provider: mockProvider,
        degraded: false,
        tier: 1 as const,
        originalRequested: 'auto',
        actualProvider: 'local-fallback',
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
      id: 'req-5',
      body: { input: 'hello' },
    }, makeReply());

    // Should use canonical runtime (no mode field = canonical)
    expect(runTurnRuntime).toHaveBeenCalled();
    expect(mockOrchestration.generate).not.toHaveBeenCalled();
    expect(result).toMatchObject({ mode: 'canonical' });
  });

  it('accepts async chat dispatch when work polling is ready', async () => {
    let registeredHandler: RouteHandler | undefined;
    const enqueueWork = vi.fn(() => ({
      workId: 'work-1',
      status: 'pending',
      type: 'chat.generate',
      capabilityScope: ['task:chat.generate'],
      attempts: 0,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    }));
    const mockApp = {
      get: () => undefined,
      post: (path: string, handler: RouteHandler) => {
        if (path === '/v1/chat/dispatch') registeredHandler = handler;
      },
    };

    await registerChatRoutes(
      mockApp as never,
      {} as never,
      {
        sessionRepository: { ensureSession: vi.fn() } as never,
        generationEventRepository: {} as never,
        workPollingService: {
          snapshot: vi.fn(() => ({
            tokenReady: true,
            sessionTtlMs: 1,
            leaseTtlMs: 1,
            sessions: { total: 0, active: 0, revoked: 0, expired: 0 },
            work: { total: 0, pending: 0, leased: 0, completed: 0, failed: 0, canceled: 0, overdueLeases: 0 },
          })),
          enqueueWork,
        } as never,
      },
    );

    const result = await registeredHandler?.(
      {
        id: 'req-6',
        body: { input: 'async hello', userId: 'telegram:7' },
      },
      makeReply(),
    );

    expect(enqueueWork).toHaveBeenCalledWith(
      expect.objectContaining({
        actorId: 'telegram:7',
        conversationId: 'primary::telegram:7',
        capabilityScope: ['task:chat.generate'],
      }),
    );
    expect(result).toMatchObject({
      ok: true,
      accepted: true,
      requestId: 'req-6',
      work: {
        workId: 'work-1',
        status: 'pending',
      },
    });
  });

  it('returns 503 for async dispatch when work polling tokens are not ready', async () => {
    let registeredHandler: RouteHandler | undefined;
    const mockApp = {
      get: () => undefined,
      post: (path: string, handler: RouteHandler) => {
        if (path === '/v1/chat/dispatch') registeredHandler = handler;
      },
    };

    await registerChatRoutes(
      mockApp as never,
      {} as never,
      {
        sessionRepository: { ensureSession: vi.fn() } as never,
        generationEventRepository: {} as never,
        workPollingService: {
          snapshot: vi.fn(() => ({
            tokenReady: false,
            sessionTtlMs: 1,
            leaseTtlMs: 1,
            sessions: { total: 0, active: 0, revoked: 0, expired: 0 },
            work: { total: 0, pending: 0, leased: 0, completed: 0, failed: 0, canceled: 0, overdueLeases: 0 },
          })),
        } as never,
      },
    );

    const result = await registeredHandler?.(
      {
        id: 'req-7',
        body: { input: 'async hello' },
      },
      makeReply(),
    );

    expect(result).toMatchObject({
      ok: false,
      error: 'work polling session tokens are not ready',
    });
  });
});
