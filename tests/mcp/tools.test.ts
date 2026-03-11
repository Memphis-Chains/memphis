import { describe, expect, it, vi } from 'vitest';
import { runMemphisJournal } from '../../src/mcp/tools/journal.js';
import { runMemphisRecall } from '../../src/mcp/tools/recall.js';
import { runMemphisDecide } from '../../src/mcp/tools/decide.js';

describe('mcp tools', () => {
  it('memphis_journal writes to journal chain', async () => {
    const append = vi.fn(async () => ({ index: 7, hash: 'abc', chain: 'journal', timestamp: new Date().toISOString() }));
    const out = await runMemphisJournal({ content: 'hello', tags: ['x'] }, { append: append as never });

    expect(append).toHaveBeenCalledWith('journal', expect.objectContaining({ content: 'hello', tags: ['x'] }));
    expect(out).toEqual({ success: true, index: 7, hash: 'abc' });
  });

  it('memphis_recall maps embed hits', () => {
    const search = vi.fn(() => ({ query: 'x', count: 1, hits: [{ id: '1', score: 0.9, text_preview: 'memory' }] }));
    const out = runMemphisRecall({ query: 'x', limit: 3 }, { search: search as never });

    expect(search).toHaveBeenCalledWith('x', 3);
    expect(out).toEqual({ results: [{ content: 'memory', score: 0.9, tags: [] }] });
  });

  it('memphis_decide writes decision chain and history', async () => {
    const append = vi.fn(async () => ({ index: 11, hash: 'h', chain: 'decisions', timestamp: new Date().toISOString() }));
    const appendHistory = vi.fn(() => 'data/decision-history.jsonl');

    const out = await runMemphisDecide({ title: 'T', choice: 'A', context: 'C' }, { append: append as never, appendHistory: appendHistory as never });

    expect(append).toHaveBeenCalledWith('decisions', expect.objectContaining({ title: 'T', choice: 'A', context: 'C' }));
    expect(appendHistory).toHaveBeenCalledTimes(1);
    expect(out).toEqual({ success: true, index: 11 });
  });
});
