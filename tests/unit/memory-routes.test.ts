import { describe, expect, it, vi } from 'vitest';

import { registerMemoryRoutes } from '../../src/infra/http/routes/memory.js';

type RouteHandler = (
  request: { body: unknown; ip?: string },
  reply: {
    status: (code: number) => { send: (payload: unknown) => unknown };
  },
) => Promise<unknown>;

function buildMockApp() {
  const routes = new Map<string, RouteHandler>();
  return {
    post(path: string, handler: RouteHandler) {
      routes.set(path, handler);
    },
    async call(path: string, body: unknown) {
      const handler = routes.get(path);
      if (!handler) throw new Error(`no route registered for ${path}`);
      const reply = {
        status(code: number) {
          return {
            send(payload: unknown) {
              return { statusCode: code, payload };
            },
          };
        },
      };
      return handler({ body, ip: '127.0.0.1' }, reply);
    },
  };
}

describe('registerMemoryRoutes — /api/recall', () => {
  it('rejects an empty query', async () => {
    const app = buildMockApp();
    registerMemoryRoutes(app, {
      store: vi.fn(),
      search: vi.fn(),
      audit: vi.fn(),
      isSafeChainName: vi.fn((chain) => typeof chain === 'string'),
    });
    await expect(app.call('/api/recall', { query: '' })).resolves.toMatchObject({
      statusCode: 400,
      payload: { ok: false, error: 'query required' },
    });
  });

  it('rejects a missing query', async () => {
    const app = buildMockApp();
    registerMemoryRoutes(app, {
      store: vi.fn(),
      search: vi.fn(),
      audit: vi.fn(),
      isSafeChainName: vi.fn((chain) => typeof chain === 'string'),
    });
    await expect(app.call('/api/recall', {})).resolves.toMatchObject({
      statusCode: 400,
      payload: { ok: false, error: 'query required' },
    });
  });

  it('rejects a limit out of range', async () => {
    const app = buildMockApp();
    registerMemoryRoutes(app, {
      store: vi.fn(),
      search: vi.fn(),
      audit: vi.fn(),
      isSafeChainName: vi.fn((chain) => typeof chain === 'string'),
    });
    await expect(app.call('/api/recall', { query: 'test', limit: 101 })).resolves.toMatchObject({
      statusCode: 400,
      payload: { ok: false, error: 'limit must be between 1 and 100' },
    });
  });

  it('filters results by userId after semantic search', async () => {
    const app = buildMockApp();
    const search = vi.fn().mockReturnValue({
      query: 'coffee',
      count: 3,
      hits: [
        { id: '1', score: 0.9, text_preview: '[u1] coffee note' },
        { id: '2', score: 0.8, text_preview: '[u2] coffee note' },
        { id: '3', score: 0.7, text_preview: '[u1] second coffee note' },
      ],
    });
    registerMemoryRoutes(app, {
      store: vi.fn(),
      search,
      audit: vi.fn(),
      isSafeChainName: vi.fn((chain) => typeof chain === 'string'),
    });

    const result = await app.call('/api/recall', { query: 'coffee', limit: 1, userId: 'u1' });
    expect(search).toHaveBeenCalledWith('coffee', 3, process.env, undefined);
    expect(result).toMatchObject({
      ok: true,
      results: {
        count: 1,
        hits: [{ id: '1' }],
      },
    });
  });
});

describe('registerMemoryRoutes — /api/journal', () => {
  it('rejects an empty content string', async () => {
    const app = buildMockApp();
    registerMemoryRoutes(app, {
      store: vi.fn(),
      search: vi.fn(),
      audit: vi.fn(),
      isSafeChainName: vi.fn((chain) => typeof chain === 'string'),
    });
    await expect(app.call('/api/journal', { content: '' })).resolves.toMatchObject({
      statusCode: 400,
      payload: { ok: false, error: 'content required' },
    });
  });

  it('rejects a missing content field', async () => {
    const app = buildMockApp();
    registerMemoryRoutes(app, {
      store: vi.fn(),
      search: vi.fn(),
      audit: vi.fn(),
      isSafeChainName: vi.fn((chain) => typeof chain === 'string'),
    });
    await expect(app.call('/api/journal', { tags: ['a'] })).resolves.toMatchObject({
      statusCode: 400,
      payload: { ok: false, error: 'content required' },
    });
  });

  it('rejects traversal-style chain names', async () => {
    const app = buildMockApp();
    registerMemoryRoutes(app, {
      store: vi.fn(),
      search: vi.fn(),
      audit: vi.fn(),
      isSafeChainName: vi.fn(() => false),
    });

    await expect(
      app.call('/api/journal', { content: 'hello world', chain: '../../tmp/pwn' }),
    ).resolves.toMatchObject({
      statusCode: 400,
      payload: { ok: false, error: 'invalid chain name' },
    });
  });

  it('accepts valid content with optional tags', async () => {
    const app = buildMockApp();
    const store = vi.fn().mockResolvedValue({
      success: true,
      memoryId: 'journal-7',
      index: 7,
      hash: 'abc123',
      indexed: true,
    });
    registerMemoryRoutes(app, {
      store,
      search: vi.fn(),
      audit: vi.fn(),
      isSafeChainName: vi.fn(() => true),
    });

    await expect(
      app.call('/api/journal', { content: 'hello world', tags: ['test'] }),
    ).resolves.toMatchObject({
      ok: true,
      index: 7,
      hash: 'abc123',
      memoryId: 'journal-7',
      indexed: true,
    });
    expect(store).toHaveBeenCalledWith(
      { content: 'hello world', tags: ['test'], chain: 'journal', source: 'http-api' },
      process.env,
    );
  });
});
