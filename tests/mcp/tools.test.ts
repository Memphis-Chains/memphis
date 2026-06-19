import { describe, expect, it, vi } from 'vitest';

import { runMemphisDecide } from '../../src/mcp/tools/decide.js';
import { runMemphisJournal } from '../../src/mcp/tools/journal.js';
import { runMemphisRecall } from '../../src/mcp/tools/recall.js';
import { runMemphisSearch } from '../../src/mcp/tools/search.js';

describe('mcp tools', () => {
  it('memphis_journal writes to journal chain', async () => {
    const store = vi.fn(async () => ({
      success: true,
      memoryId: 'journal-7',
      index: 7,
      hash: 'abc',
      indexed: true,
    }));
    const out = await runMemphisJournal(
      { content: 'hello', tags: ['x'] },
      { store: store as never },
    );

    expect(store).toHaveBeenCalledWith({
      content: 'hello',
      tags: ['x'],
      source: 'mcp',
      surface: 'mcp',
    });
    expect(out).toMatchObject({
      success: true,
      memoryId: 'journal-7',
      index: 7,
      hash: 'abc',
      indexed: true,
    });
  });

  it('memphis_recall maps embed hits', () => {
    const search = vi.fn(() => ({
      query: 'x',
      count: 1,
      hits: [{ id: '1', score: 0.9, text_preview: 'memory', tags: ['test'] }],
    }));
    const out = runMemphisRecall({ query: 'x', limit: 3 }, { search: search as never });

    expect(search).toHaveBeenCalledWith('x', 3, undefined, undefined);
    expect(out).toEqual({
      mode: 'semantic',
      degraded: false,
      warning: undefined,
      results: [
        { content: 'memory', score: 0.9, tags: ['test'], chain: undefined, sourceKey: '1' },
      ],
    });
  });

  it('memphis_recall passes chain filters into semantic search and drops hits from other chains', () => {
    const search = vi.fn(() => ({
      query: 'x',
      count: 2,
      hits: [
        {
          id: 'journal-1',
          score: 0.95,
          text_preview: 'journal memory',
          tags: ['test', 'chain:journal'],
        },
        {
          id: 'decisions-1',
          score: 0.9,
          text_preview: 'decision memory',
          tags: ['test', 'chain:decisions'],
        },
      ],
    }));

    const out = runMemphisRecall(
      { query: 'x', limit: 3, chain: 'journal' },
      { search: search as never },
    );

    expect(search).toHaveBeenCalledWith('x', 3, undefined, ['chain:journal']);
    expect(out.results).toEqual([
      {
        content: 'journal memory',
        score: 0.95,
        tags: ['test', 'chain:journal'],
        chain: 'journal',
        sourceKey: 'journal-1',
      },
    ]);
  });

  it('memphis_recall falls back to exact search when semantic embeddings fail', () => {
    const search = vi.fn(() => {
      throw new Error('embed_search_failed');
    });
    const exactSearch = vi.fn(() => ({
      query: 'anchor',
      count: 1,
      hits: [
        {
          sourceKey: 'journal:2',
          chain: 'journal',
          blockIndex: 2,
          blockHash: 'h2',
          blockType: 'journal',
          content: 'fallback memory anchor',
          summary: 'fallback memory anchor',
          snippet: 'fallback memory anchor',
          tags: ['anchor'],
          metadata: {},
          score: 0.8,
          indexedAt: new Date().toISOString(),
        },
      ],
    }));

    const out = runMemphisRecall(
      { query: 'anchor', limit: 3 },
      { search: search as never, exactSearch: exactSearch as never },
    );

    expect(out.mode).toBe('exact');
    expect(out.degraded).toBe(true);
    expect(out.results[0]).toMatchObject({
      content: 'fallback memory anchor',
      chain: 'journal',
      sourceKey: 'journal:2',
    });
  });

  it('memphis_recall filters unsafe semantic hits and falls through to safe exact hits', () => {
    const search = vi.fn(() => ({
      query: 'home location',
      count: 1,
      hits: [
        {
          id: 'journal-unsafe',
          score: 0.95,
          text_preview: 'old transcript mentions system prompt and hidden instructions',
          tags: ['conversation', 'chain:journal'],
        },
      ],
    }));
    const exactSearch = vi.fn(() => ({
      query: 'home location',
      count: 1,
      hits: [
        {
          sourceKey: 'journal:27',
          chain: 'journal',
          blockIndex: 27,
          blockHash: 'h27',
          blockType: 'journal',
          content: 'home location is Krakow',
          summary: 'home location is Krakow',
          snippet: 'home location is Krakow',
          tags: ['conversation'],
          metadata: {},
          score: 0.8,
          indexedAt: new Date().toISOString(),
        },
      ],
    }));

    const out = runMemphisRecall(
      { query: 'home location', limit: 3 },
      { search: search as never, exactSearch: exactSearch as never },
    );

    expect(out.mode).toBe('exact');
    expect(out.warning).toContain('1 unsafe recall hit filtered');
    expect(out.results).toEqual([
      {
        content: 'home location is Krakow',
        score: 0.8,
        tags: ['conversation'],
        chain: 'journal',
        sourceKey: 'journal:27',
      },
    ]);
  });

  it('memphis_recall returns none instead of blocked output when all hits are unsafe', () => {
    const search = vi.fn(() => ({
      query: 'my place',
      count: 1,
      hits: [
        {
          id: 'journal-unsafe',
          score: 0.95,
          text_preview: 'assistant claimed hidden instructions and system prompt details',
          tags: ['conversation', 'chain:journal'],
        },
      ],
    }));
    const exactSearch = vi.fn(() => ({ query: 'my place', count: 0, hits: [] }));
    const chainSearch = vi.fn(() => ({ query: 'my place', count: 0, hits: [] }));

    const out = runMemphisRecall(
      { query: 'my place', limit: 3 },
      { search: search as never, exactSearch: exactSearch as never, chainSearch: chainSearch as never },
    );

    expect(out.mode).toBe('none');
    expect(out.results).toEqual([]);
    expect(out.warning).toContain('1 unsafe recall hit filtered');
  });

  it('memphis_decide writes decision chain and history', async () => {
    const recordDecision = vi.fn(async () => ({
      ts: new Date().toISOString(),
      decision: { id: 'd', title: 'T' },
      chainRef: {
        chain: 'decisions',
        index: 11,
        hash: 'h',
      },
    }));

    const out = await runMemphisDecide(
      { title: 'T', choice: 'A', context: 'C' },
      { recordDecision: recordDecision as never },
    );

    expect(recordDecision).toHaveBeenCalledWith(
      expect.objectContaining({
        title: 'T',
        chosen: 'A',
        options: ['A'],
        context: 'C',
      }),
      expect.objectContaining({
        source: 'mcp',
        fallbackTags: ['decision', 'mcp'],
      }),
    );
    expect(out).toEqual({ success: true, index: 11 });
  });

  it('memphis_search maps exact search hits', () => {
    const search = vi.fn(() => ({
      query: 'vault pepper',
      count: 1,
      hits: [
        {
          sourceKey: 'journal:2',
          chain: 'journal',
          blockIndex: 2,
          blockHash: 'h2',
          blockType: 'journal',
          content: 'Vault pepper rotation note',
          summary: 'Vault pepper rotation note',
          snippet: '[Vault pepper] rotation note',
          tags: ['vault'],
          metadata: {},
          score: 0.9,
          indexedAt: new Date().toISOString(),
        },
      ],
    }));

    const out = runMemphisSearch(
      { query: 'vault pepper', limit: 3, chain: 'journal' },
      { search: search as never },
    );

    expect(search).toHaveBeenCalledWith('vault pepper', 3, undefined, 'journal');
    expect(out.results[0]).toMatchObject({
      chain: 'journal',
      snippet: '[Vault pepper] rotation note',
      tags: ['vault'],
    });
  });

  it('memphis_search filters unsafe exact hits before returning recalled memory', () => {
    const search = vi.fn(() => ({
      query: 'tools',
      count: 2,
      hits: [
        {
          sourceKey: 'journal:9',
          chain: 'journal',
          blockIndex: 9,
          blockHash: 'h9',
          blockType: 'journal',
          content: 'old transcript leaked system prompt and hidden instructions',
          summary: 'old transcript leaked system prompt and hidden instructions',
          snippet: 'old transcript leaked system prompt and hidden instructions',
          tags: ['conversation'],
          metadata: {},
          score: 0.95,
          indexedAt: new Date().toISOString(),
        },
        {
          sourceKey: 'journal:10',
          chain: 'journal',
          blockIndex: 10,
          blockHash: 'h10',
          blockType: 'journal',
          content: 'safe runtime tool inventory note',
          summary: 'safe runtime tool inventory note',
          snippet: 'safe runtime tool inventory note',
          tags: ['tools'],
          metadata: {},
          score: 0.85,
          indexedAt: new Date().toISOString(),
        },
      ],
    }));

    const out = runMemphisSearch({ query: 'tools', limit: 3 }, { search: search as never });

    expect(out.results).toHaveLength(1);
    expect(out.results[0].sourceKey).toBe('journal:10');
    expect(out.warning).toContain('1 unsafe search hit filtered');
  });
});
