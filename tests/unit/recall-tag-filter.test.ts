import { describe, expect, it, vi } from 'vitest';

import { registerMemoryRoutes } from '../../src/infra/http/routes/memory.js';
import { runMemphisRecall } from '../../src/mcp/tools/recall.js';

describe('recall — tag filtering', () => {
  it('passes tags to search function', () => {
    const search = vi.fn(() => ({
      query: 'coffee',
      count: 2,
      hits: [
        { id: '1', score: 0.9, text_preview: 'espresso notes', tags: ['userA'] },
        { id: '2', score: 0.8, text_preview: 'latte art', tags: ['userB'] },
      ],
    }));

    const out = runMemphisRecall(
      { query: 'coffee', limit: 5, tags: ['userA'] },
      { search: search as never },
    );

    expect(search).toHaveBeenCalledWith('coffee', 5, undefined, ['userA']);
    expect(out.results).toHaveLength(2);
    expect(out.results[0]!.tags).toEqual(['userA']);
    expect(out.results[1]!.tags).toEqual(['userB']);
  });

  it('returns tags from search hits', () => {
    const search = vi.fn(() => ({
      query: 'test',
      count: 1,
      hits: [
        { id: '1', score: 0.95, text_preview: 'hello world', tags: ['greeting', 'test'] },
      ],
    }));

    const out = runMemphisRecall({ query: 'test' }, { search: search as never });

    expect(out.results[0]!.tags).toEqual(['greeting', 'test']);
    expect(out.results[0]!.content).toBe('hello world');
  });

  it('handles missing tags gracefully', () => {
    const search = vi.fn(() => ({
      query: 'test',
      count: 1,
      hits: [{ id: '1', score: 0.9, text_preview: 'no tags' }],
    }));

    const out = runMemphisRecall({ query: 'test' }, { search: search as never });
    expect(out.results[0]!.tags).toEqual([]);
  });

  it('does not pass tags when none provided', () => {
    const search = vi.fn(() => ({
      query: 'x',
      count: 0,
      hits: [],
    }));

    runMemphisRecall({ query: 'x' }, { search: search as never });
    expect(search).toHaveBeenCalledWith('x', 5, undefined, undefined);
  });
});

describe('recall route — tag filtering via HTTP', () => {
  function buildMockApp() {
    const handlers = new Map<
      string,
      (req: { body: unknown; ip?: string }, reply: unknown) => Promise<unknown>
    >();
    return {
      post(path: string, handler: (req: { body: unknown }, reply: unknown) => Promise<unknown>) {
        handlers.set(path, handler);
      },
      async call(path: string, body: unknown) {
        const handler = handlers.get(path)!;
        const reply = { status: (code: number) => ({ send: (p: unknown) => ({ code, ...p as object }) }) };
        return handler({ body, ip: '127.0.0.1' }, reply);
      },
    };
  }

  it('passes tags from request body to search', async () => {
    const app = buildMockApp();
    const search = vi.fn().mockReturnValue({
      query: 'coffee',
      count: 1,
      hits: [{ id: '1', score: 0.9, text_preview: 'espresso', tags: ['userA'] }],
    });

    registerMemoryRoutes(app, {
      store: vi.fn(),
      search,
      audit: vi.fn(),
      isSafeChainName: vi.fn(() => true),
    });

    await app.call('/api/recall', { query: 'coffee', tags: ['userA'] });
    expect(search).toHaveBeenCalledWith('coffee', 10, process.env, ['userA']);
  });

  it('ignores empty tags array', async () => {
    const app = buildMockApp();
    const search = vi.fn().mockReturnValue({
      query: 'test',
      count: 0,
      hits: [],
    });

    registerMemoryRoutes(app, {
      store: vi.fn(),
      search,
      audit: vi.fn(),
      isSafeChainName: vi.fn(() => true),
    });

    await app.call('/api/recall', { query: 'test', tags: [] });
    expect(search).toHaveBeenCalledWith('test', 10, process.env, undefined);
  });

  it('filters non-string tags from request', async () => {
    const app = buildMockApp();
    const search = vi.fn().mockReturnValue({
      query: 'test',
      count: 0,
      hits: [],
    });

    registerMemoryRoutes(app, {
      store: vi.fn(),
      search,
      audit: vi.fn(),
      isSafeChainName: vi.fn(() => true),
    });

    await app.call('/api/recall', { query: 'test', tags: ['valid', 123, null, 'also-valid'] });
    expect(search).toHaveBeenCalledWith('test', 10, process.env, ['valid', 'also-valid']);
  });

  it('combines tag filter with userId filter', async () => {
    const app = buildMockApp();
    const search = vi.fn().mockReturnValue({
      query: 'coffee',
      count: 2,
      hits: [
        { id: '1', score: 0.9, text_preview: '[u1] espresso', tags: ['userA'] },
        { id: '2', score: 0.8, text_preview: 'latte', tags: ['userA'] },
      ],
    });

    registerMemoryRoutes(app, {
      store: vi.fn(),
      search,
      audit: vi.fn(),
      isSafeChainName: vi.fn(() => true),
    });

    const result = await app.call('/api/recall', {
      query: 'coffee',
      tags: ['userA'],
      userId: 'u1',
      limit: 5,
    });

    // Tags filter passed to search, userId filter applied post-search
    expect(search).toHaveBeenCalledWith('coffee', 15, process.env, ['userA']);
    expect(result).toMatchObject({
      ok: true,
      results: { count: 1, hits: [{ id: '1' }] },
    });
  });
});
