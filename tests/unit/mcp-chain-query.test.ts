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

  // Decision #190 / item 5: tokenised AND match. Each test below is
  // a false-negative the substring variant produced. The new behaviour
  // keeps the same single-token contract (case-insensitive substring
  // per token) but extends it to multi-word queries.
  it('matches multi-word queries with tokenised AND (order-independent)', async () => {
    const { getRecentBlocks } = await import('../../src/infra/storage/rust-chain-adapter.js');
    vi.mocked(getRecentBlocks).mockResolvedValue([
      { index: 0, hash: 'a', data: { type: 'entry', content: 'reindex embed via atomic rename' } },
      { index: 1, hash: 'b', data: { type: 'entry', content: 'reindex only' } },
    ] as never);

    // Substring variant: 'embed reindex'.includes('embed reindex') is
    // false in block 0 — the words appear re-ordered. Tokenised AND
    // catches it. Block 1 only contains one of the two tokens and is
    // excluded by the AND.
    const result = await runMemphisChainQuery({ contains: 'embed reindex' });
    expect(result.count).toBe(1);
    expect((result.blocks[0]!.data as Record<string, unknown>).content).toBe(
      'reindex embed via atomic rename',
    );
  });

  it('matches case-insensitively (multi-word)', async () => {
    const { getRecentBlocks } = await import('../../src/infra/storage/rust-chain-adapter.js');
    vi.mocked(getRecentBlocks).mockResolvedValue([
      { index: 0, hash: 'a', data: { type: 'entry', content: 'Decided to fix Embed Reindex bug' } },
      { index: 1, hash: 'b', data: { type: 'entry', content: 'unrelated' } },
    ] as never);

    const result = await runMemphisChainQuery({ contains: 'EMBED reindex' });
    expect(result.count).toBe(1);
  });

  it('matches Polish Unicode tokens without ASCII folding', async () => {
    const { getRecentBlocks } = await import('../../src/infra/storage/rust-chain-adapter.js');
    vi.mocked(getRecentBlocks).mockResolvedValue([
      { index: 0, hash: 'a', data: { type: 'entry', content: 'przejście do nowej wersji ąęśćółż' } },
      { index: 1, hash: 'b', data: { type: 'entry', content: 'ascii only' } },
    ] as never);

    // ą must NOT match `a` — preserve case + Polish diacritics
    // exactly. Operators writing in Polish rely on this.
    const ąResult = await runMemphisChainQuery({ contains: 'ą' });
    expect(ąResult.count).toBe(1);

    // Tokenised AND with Polish characters
    const phraseResult = await runMemphisChainQuery({ contains: 'przejście wersji' });
    expect(phraseResult.count).toBe(1);
  });

  it('returns no blocks for a multi-word query where only some tokens match (AND semantics)', async () => {
    const { getRecentBlocks } = await import('../../src/infra/storage/rust-chain-adapter.js');
    vi.mocked(getRecentBlocks).mockResolvedValue([
      { index: 0, hash: 'a', data: { type: 'entry', content: 'embed only' } },
      { index: 1, hash: 'b', data: { type: 'entry', content: 'reindex only' } },
      { index: 2, hash: 'c', data: { type: 'entry', content: 'embed and reindex together' } },
    ] as never);

    // Both tokens required — first two blocks fail the AND.
    const result = await runMemphisChainQuery({ contains: 'embed reindex' });
    expect(result.count).toBe(1);
    expect((result.blocks[0]!.data as Record<string, unknown>).content).toBe(
      'embed and reindex together',
    );
  });

  it('returns no blocks when contains is whitespace only', async () => {
    const { getRecentBlocks } = await import('../../src/infra/storage/rust-chain-adapter.js');
    vi.mocked(getRecentBlocks).mockResolvedValue([
      { index: 0, hash: 'a', data: { type: 'entry', content: 'first' } },
      { index: 1, hash: 'b', data: { type: 'entry', content: 'second' } },
    ] as never);

    const result = await runMemphisChainQuery({ contains: '   \t  ' });
    expect(result.count).toBe(0);
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
