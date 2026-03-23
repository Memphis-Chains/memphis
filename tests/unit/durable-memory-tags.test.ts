import { describe, expect, it, vi } from 'vitest';

import { storeDurableMemory } from '../../src/infra/memory/durable-memory.js';

describe('durable memory — tag propagation', () => {
  it('passes tags to embed index', async () => {
    const append = vi.fn(async () => ({
      index: 1,
      hash: 'h1',
      chain: 'journal',
      timestamp: new Date().toISOString(),
    }));
    const index = vi.fn(() => ({
      id: 'mem-1',
      count: 1,
      dim: 768,
      provider: 'ollama',
    }));

    await storeDurableMemory(
      {
        memoryId: 'mem-1',
        content: 'User prefers dark mode',
        tags: ['user-pref', 'ui'],
        source: 'api',
      },
      { append: append as never, index: index as never },
    );

    expect(index).toHaveBeenCalledWith('mem-1', 'User prefers dark mode', undefined, [
      'user-pref',
      'ui',
    ]);
  });

  it('passes undefined tags when none provided', async () => {
    const append = vi.fn(async () => ({
      index: 2,
      hash: 'h2',
      chain: 'journal',
      timestamp: new Date().toISOString(),
    }));
    const index = vi.fn(() => ({
      id: 'journal-2',
      count: 1,
      dim: 32,
      provider: 'local',
    }));

    await storeDurableMemory(
      { content: 'Simple note' },
      { append: append as never, index: index as never },
    );

    expect(index).toHaveBeenCalledWith('journal-2', 'Simple note', undefined, undefined);
  });

  it('passes empty tags array through', async () => {
    const append = vi.fn(async () => ({
      index: 3,
      hash: 'h3',
      chain: 'journal',
      timestamp: new Date().toISOString(),
    }));
    const index = vi.fn(() => ({
      id: 'mem-3',
      count: 1,
      dim: 32,
      provider: 'local',
    }));

    await storeDurableMemory(
      { memoryId: 'mem-3', content: 'No tags', tags: [] },
      { append: append as never, index: index as never },
    );

    // Empty tags array is passed through (not undefined)
    expect(index).toHaveBeenCalledWith('mem-3', 'No tags', undefined, []);
  });
});
