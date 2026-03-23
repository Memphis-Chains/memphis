import { describe, expect, it, vi, beforeEach } from 'vitest';

import { runMemphisEmbedStore, runMemphisEmbedSearch } from '../../src/mcp/tools/embed.js';

vi.mock('../../src/infra/storage/rust-embed-adapter.js', () => ({
  embedStore: vi.fn(),
  embedSearch: vi.fn(),
}));

describe('embed MCP tools — tag support', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('passes tags to embedStore', async () => {
    const { embedStore } = await import('../../src/infra/storage/rust-embed-adapter.js');
    vi.mocked(embedStore).mockReturnValue({
      id: 'doc-1',
      count: 5,
      dim: 768,
      provider: 'ollama',
    });

    const result = runMemphisEmbedStore({
      id: 'doc-1',
      text: 'hello world',
      tags: ['userA', 'greeting'],
    });

    expect(embedStore).toHaveBeenCalledWith('doc-1', 'hello world', undefined, [
      'userA',
      'greeting',
    ]);
    expect(result.stored).toBe(true);
    expect(result.id).toBe('doc-1');
    expect(result.dim).toBe(768);
  });

  it('stores without tags when none provided', async () => {
    const { embedStore } = await import('../../src/infra/storage/rust-embed-adapter.js');
    vi.mocked(embedStore).mockReturnValue({
      id: 'doc-2',
      count: 1,
      dim: 32,
      provider: 'local-deterministic',
    });

    runMemphisEmbedStore({ id: 'doc-2', text: 'no tags' });

    expect(embedStore).toHaveBeenCalledWith('doc-2', 'no tags', undefined, undefined);
  });

  it('passes tags filter to embedSearch', async () => {
    const { embedSearch } = await import('../../src/infra/storage/rust-embed-adapter.js');
    vi.mocked(embedSearch).mockReturnValue({
      query: 'test',
      count: 1,
      hits: [{ id: '1', score: 0.95, text_preview: 'found', tags: ['userA'] }],
    });

    const result = runMemphisEmbedSearch({
      query: 'test',
      topK: 3,
      tags: ['userA'],
    });

    expect(embedSearch).toHaveBeenCalledWith('test', 3, undefined, ['userA']);
    expect(result.count).toBe(1);
    expect(result.hits[0]!.tags).toEqual(['userA']);
  });

  it('searches without tag filter when none provided', async () => {
    const { embedSearch } = await import('../../src/infra/storage/rust-embed-adapter.js');
    vi.mocked(embedSearch).mockReturnValue({
      query: 'x',
      count: 0,
      hits: [],
    });

    runMemphisEmbedSearch({ query: 'x' });

    expect(embedSearch).toHaveBeenCalledWith('x', 5, undefined, undefined);
  });
});
