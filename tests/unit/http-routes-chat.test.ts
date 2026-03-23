/**
 * Tests for chat HTTP route (src/infra/http/routes/chat.ts).
 * Validates the registerChatRoutes function shape and schema validation.
 */

import { describe, expect, it } from 'vitest';

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
});
