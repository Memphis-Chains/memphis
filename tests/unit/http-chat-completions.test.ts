import { describe, expect, it } from 'vitest';

import { registerChatCompletionsRoutes } from '../../src/infra/http/routes/chat-completions.js';

describe('chat completions tombstone', () => {
  it('returns 410 and points callers to chat generate', async () => {
    let registeredHandler:
      | ((
          request: { body: unknown; ip: string; id: string },
          reply: { status: (code: number) => { send: (body: unknown) => unknown } },
        ) => Promise<unknown>)
      | undefined;
    const app = {
      post: (
        _path: string,
        handler: (
          request: { body: unknown; ip: string; id: string },
          reply: { status: (code: number) => { send: (body: unknown) => unknown } },
        ) => Promise<unknown>,
      ) => {
        registeredHandler = handler;
      },
    };

    await registerChatCompletionsRoutes(app as never, {} as never);

    let statusCode = 200;
    let payload: unknown;
    await registeredHandler?.(
      { body: { messages: [] }, ip: '127.0.0.1', id: 'req-1' },
      {
        status(code: number) {
          statusCode = code;
          return {
            send(body: unknown) {
              payload = body;
              return body;
            },
          };
        },
      },
    );

    expect(statusCode).toBe(410);
    expect(payload).toMatchObject({
      ok: false,
      error: 'deprecated',
      requestId: 'req-1',
    });
    expect((payload as { message: string }).message).toContain('/v1/chat/generate');
  });
});
