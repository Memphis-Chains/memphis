import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { MemphisMemoryProvider } from '../src/MemoryProvider.js';

describe('MemphisMemoryProvider', () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  it('search maps recall results to OpenClaw format', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        ok: true,
        results: [{ hash: 'h1', content: 'hello', score: 0.91, tags: ['x'], chain: 'journal', index: 7 }],
      }),
    });

    const provider = new MemphisMemoryProvider({ baseUrl: 'http://localhost:3000' });
    const results = await provider.search('hello', { limit: 5 });

    expect(fetchMock).toHaveBeenCalledOnce();
    expect(results[0]).toEqual({
      id: 'h1',
      content: 'hello',
      score: 0.91,
      metadata: { tags: ['x'], chain: 'journal', index: 7 },
    });
  });

  it('save persists via journal endpoint and returns id', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ ok: true, index: 42, hash: 'h42' }),
    });

    const provider = new MemphisMemoryProvider();
    const id = await provider.save('entry', { tags: ['alpha'] });

    expect(id).toBe('h42');
    expect(fetchMock).toHaveBeenCalledWith(
      'http://localhost:3000/api/journal',
      expect.objectContaining({ method: 'POST' }),
    );
  });

  it('delete writes tombstone through decide chain', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ ok: true }),
    });

    const provider = new MemphisMemoryProvider();
    const deleted = await provider.delete('abc123');

    expect(deleted).toBe(true);
    expect(fetchMock).toHaveBeenCalledWith(
      'http://localhost:3000/api/decide',
      expect.objectContaining({ method: 'POST' }),
    );
  });

  it('adds negligible provider overhead (<100ms) for mocked request', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({ ok: true, results: [] }),
    });

    const provider = new MemphisMemoryProvider();
    const start = performance.now();
    await provider.search('perf');
    const duration = performance.now() - start;

    expect(duration).toBeLessThan(100);
  });
});
