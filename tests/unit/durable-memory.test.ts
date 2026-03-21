import { describe, expect, it, vi } from 'vitest';

import { storeDurableMemory } from '../../src/infra/memory/durable-memory.js';

describe('durable memory', () => {
  it('stores chain-backed memory with explicit memory id', async () => {
    const append = vi.fn(async () => ({
      index: 12,
      hash: 'abc123',
      chain: 'journal',
      timestamp: new Date().toISOString(),
    }));
    const index = vi.fn(() => ({
      id: 'guest-123',
      count: 1,
      dim: 32,
      provider: 'local-deterministic',
    }));

    const out = await storeDurableMemory(
      {
        memoryId: 'guest-123',
        content: 'Guest prefers mountain view',
        tags: ['guest', 'preference'],
        source: 'cli-embed',
      },
      { append: append as never, index: index as never },
    );

    expect(append).toHaveBeenCalledWith(
      'journal',
      expect.objectContaining({
        content: 'Guest prefers mountain view',
        tags: ['guest', 'preference'],
        source: 'cli-embed',
        memory_id: 'guest-123',
      }),
    );
    expect(index).toHaveBeenCalledWith('guest-123', 'Guest prefers mountain view');
    expect(out).toMatchObject({
      success: true,
      memoryId: 'guest-123',
      index: 12,
      hash: 'abc123',
      indexed: true,
    });
  });

  it('falls back to generated journal id when memory id is omitted', async () => {
    const append = vi.fn(async () => ({
      index: 4,
      hash: 'xyz',
      chain: 'journal',
      timestamp: new Date().toISOString(),
    }));
    const index = vi.fn(() => ({
      id: 'journal-4',
      count: 1,
      dim: 32,
      provider: 'local-deterministic',
    }));

    const out = await storeDurableMemory(
      {
        content: 'Remember this',
      },
      { append: append as never, index: index as never },
    );

    expect(index).toHaveBeenCalledWith('journal-4', 'Remember this');
    expect(out.memoryId).toBe('journal-4');
  });
});
