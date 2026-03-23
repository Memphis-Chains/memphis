import { describe, expect, it, vi, beforeEach } from 'vitest';

import { runMemphisChainQuery } from '../../src/mcp/tools/chain-query.js';

vi.mock('../../src/infra/storage/rust-chain-adapter.js', () => ({
  getRecentBlocks: vi.fn(),
}));

describe('mcp tools — chain-query', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('returns blocks from default journal chain', async () => {
    const { getRecentBlocks } = await import('../../src/infra/storage/rust-chain-adapter.js');
    vi.mocked(getRecentBlocks).mockResolvedValue([
      { index: 0, hash: 'a', data: { type: 'entry', content: 'hello' } },
      { index: 1, hash: 'b', data: { type: 'entry', content: 'world' } },
    ] as never);

    const result = await runMemphisChainQuery({});
    expect(getRecentBlocks).toHaveBeenCalledWith('journal', 20);
    expect(result.chain).toBe('journal');
    expect(result.count).toBe(2);
  });

  it('respects custom chain and limit', async () => {
    const { getRecentBlocks } = await import('../../src/infra/storage/rust-chain-adapter.js');
    vi.mocked(getRecentBlocks).mockResolvedValue([]);

    await runMemphisChainQuery({ chain: 'decisions', limit: 5 });
    expect(getRecentBlocks).toHaveBeenCalledWith('decisions', 5);
  });

  it('filters by blockType', async () => {
    const { getRecentBlocks } = await import('../../src/infra/storage/rust-chain-adapter.js');
    vi.mocked(getRecentBlocks).mockResolvedValue([
      { index: 0, hash: 'a', data: { type: 'entry', content: 'x' } },
      { index: 1, hash: 'b', data: { type: 'decision', content: 'y' } },
      { index: 2, hash: 'c', data: { type: 'entry', content: 'z' } },
    ] as never);

    const result = await runMemphisChainQuery({ blockType: 'decision' });
    expect(result.count).toBe(1);
    expect((result.blocks[0]!.data as Record<string, unknown>).type).toBe('decision');
  });

  it('filters by content substring', async () => {
    const { getRecentBlocks } = await import('../../src/infra/storage/rust-chain-adapter.js');
    vi.mocked(getRecentBlocks).mockResolvedValue([
      { index: 0, hash: 'a', data: { type: 'entry', content: 'hello world' } },
      { index: 1, hash: 'b', data: { type: 'entry', content: 'goodbye' } },
    ] as never);

    const result = await runMemphisChainQuery({ contains: 'hello' });
    expect(result.count).toBe(1);
  });

  it('filters by tag', async () => {
    const { getRecentBlocks } = await import('../../src/infra/storage/rust-chain-adapter.js');
    vi.mocked(getRecentBlocks).mockResolvedValue([
      { index: 0, hash: 'a', data: { type: 'entry', tags: ['important'] } },
      { index: 1, hash: 'b', data: { type: 'entry', tags: ['routine'] } },
    ] as never);

    const result = await runMemphisChainQuery({ tag: 'important' });
    expect(result.count).toBe(1);
  });

  it('applies offset before filtering', async () => {
    const { getRecentBlocks } = await import('../../src/infra/storage/rust-chain-adapter.js');
    vi.mocked(getRecentBlocks).mockResolvedValue([
      { index: 0, hash: 'a', data: { type: 'entry' } },
      { index: 1, hash: 'b', data: { type: 'entry' } },
      { index: 2, hash: 'c', data: { type: 'entry' } },
    ] as never);

    const result = await runMemphisChainQuery({ offset: 1, limit: 10 });
    expect(getRecentBlocks).toHaveBeenCalledWith('journal', 11); // limit + offset
    expect(result.count).toBe(2);
  });

  it('limits results after filtering', async () => {
    const { getRecentBlocks } = await import('../../src/infra/storage/rust-chain-adapter.js');
    const blocks = Array.from({ length: 10 }, (_, i) => ({
      index: i,
      hash: `h${i}`,
      data: { type: 'entry' },
    }));
    vi.mocked(getRecentBlocks).mockResolvedValue(blocks as never);

    const result = await runMemphisChainQuery({ limit: 3 });
    expect(result.count).toBe(3);
  });
});
