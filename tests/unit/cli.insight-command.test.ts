import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { loadBlocksForPeriod, runInsightCommand } from '../../src/cli/commands/insight.js';
import type { IStore } from '../../src/cognitive/store.js';
import type { Block } from '../../src/memory/chain.js';

const { getRecentBlocksMock } = vi.hoisted(() => ({
  getRecentBlocksMock: vi.fn(),
}));

vi.mock('../../src/infra/storage/rust-chain-adapter.js', () => ({
  getRecentBlocks: getRecentBlocksMock,
}));

function block(timestamp: string, chain: string, content: string, tags: string[] = []): Block {
  return {
    timestamp,
    chain,
    data: {
      type: chain,
      content,
      tags,
    },
  };
}

describe('insight command', () => {
  beforeEach(() => {
    getRecentBlocksMock.mockReset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('loads and time-sorts blocks using weekly plan limits', async () => {
    getRecentBlocksMock.mockImplementation(async (chain: string) => {
      if (chain === 'journal') {
        return [block('2026-03-10T10:00:00.000Z', 'journal', 'journal-1')];
      }
      if (chain === 'decision') {
        return [block('2026-03-10T09:00:00.000Z', 'decision', 'decision-1')];
      }
      return [block('2026-03-10T11:00:00.000Z', 'reflections', 'reflection-1')];
    });

    const out = await loadBlocksForPeriod('weekly');

    expect(getRecentBlocksMock).toHaveBeenCalledTimes(3);
    expect(getRecentBlocksMock).toHaveBeenNthCalledWith(1, 'journal', 240);
    expect(getRecentBlocksMock).toHaveBeenNthCalledWith(2, 'decision', 120);
    expect(getRecentBlocksMock).toHaveBeenNthCalledWith(3, 'reflections', 80);

    expect(out.map((b) => b.data?.content)).toEqual(['decision-1', 'journal-1', 'reflection-1']);
  });

  it('persists a journal report when save=true', async () => {
    const append = vi.fn().mockResolvedValue({
      index: 1,
      hash: 'h',
      chain: 'insights',
      timestamp: new Date().toISOString(),
    });
    const store: IStore = { append };

    await runInsightCommand(
      [block(new Date().toISOString(), 'journal', 'focus on quality gate', ['quality'])],
      { format: 'json', save: true, period: 'daily' },
      store,
    );

    expect(append).toHaveBeenCalled();
    const journalCall = append.mock.calls.find((call) => call[0] === 'journal');
    expect(journalCall).toBeDefined();
    expect(journalCall?.[1]).toMatchObject({
      type: 'insight-report',
      source: 'insight-command',
      period: 'daily',
    });
  });
});
