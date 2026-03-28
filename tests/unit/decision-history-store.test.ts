import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { beforeEach, describe, expect, it, vi } from 'vitest';

const { getRecentBlocksMock } = vi.hoisted(() => ({
  getRecentBlocksMock: vi.fn(),
}));

const { appendBlockMock, indexExactSearchBlockMock } = vi.hoisted(() => ({
  appendBlockMock: vi.fn(),
  indexExactSearchBlockMock: vi.fn(),
}));

vi.mock('../../src/infra/storage/rust-chain-adapter.js', () => ({
  getRecentBlocks: getRecentBlocksMock,
}));

vi.mock('../../src/infra/storage/chain-adapter.js', () => ({
  appendBlock: appendBlockMock,
}));

vi.mock('../../src/infra/memory/exact-search.js', () => ({
  indexExactSearchBlock: indexExactSearchBlockMock,
}));

import {
  appendDecisionHistory,
  recordDecisionHistoryEntry,
  readCanonicalDecisionHistory,
  readDecisionHistory,
} from '../../src/core/decision-history-store.js';
import { createDecision } from '../../src/core/decision-lifecycle.js';

describe('decision history store', () => {
  beforeEach(() => {
    getRecentBlocksMock.mockReset();
    appendBlockMock.mockReset();
    indexExactSearchBlockMock.mockReset();
  });

  it('appends snapshots and reads them back', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mv4-decision-history-'));
    try {
      const path = join(dir, 'history.jsonl');
      appendDecisionHistory(createDecision({ id: 'd1', title: 'Pick provider' }), {
        path,
        chainRef: { chain: 'decision-history', index: 1, hash: 'abc' },
      });
      const entries = readDecisionHistory(path);
      expect(entries).toHaveLength(1);
      expect(entries[0]?.decision.id).toBe('d1');
      expect(entries[0]?.chainRef?.hash).toBe('abc');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('reads canonical decision history from the decisions chain by default', async () => {
    getRecentBlocksMock.mockResolvedValueOnce([
      {
        index: 7,
        hash: 'decision-hash',
        chain: 'decisions',
        timestamp: '2026-03-28T08:00:00.000Z',
        data: {
          id: 'decision-7',
          title: 'Prefer chain-first cognition',
          choice: 'use decisions chain as source of truth',
          context: 'local runtime consolidation',
          confidence: 0.88,
          refs: ['chain:decisions#7'],
        },
      },
    ]);

    const entries = await readCanonicalDecisionHistory();

    expect(getRecentBlocksMock).toHaveBeenCalledWith('decisions', 10000);
    expect(entries).toHaveLength(1);
    expect(entries[0]?.decision).toMatchObject({
      id: 'decision-7',
      title: 'Prefer chain-first cognition',
      chosen: 'use decisions chain as source of truth',
    });
    expect(entries[0]?.chainRef).toMatchObject({
      chain: 'decisions',
      index: 7,
      hash: 'decision-hash',
    });
  });

  it('records canonical decision history into the decisions chain and exact index', async () => {
    appendBlockMock.mockResolvedValueOnce({
      index: 12,
      hash: 'chain-hash-12',
      chain: 'decisions',
      timestamp: '2026-03-28T09:00:00.000Z',
    });

    const decision = createDecision({
      id: 'decision-12',
      title: 'Keep decisions chain-first',
      options: ['chain-first'],
      chosen: 'chain-first',
      context: 'remove jsonl drift',
      confidence: 0.91,
    });

    const entry = await recordDecisionHistoryEntry(decision, {
      source: 'cli',
      correlationId: 'corr-12',
      fallbackTags: ['decision', 'cli'],
      extraData: { transitionTo: 'accepted' },
    });

    expect(appendBlockMock).toHaveBeenCalledWith(
      'decisions',
      expect.objectContaining({
        id: 'decision-12',
        title: 'Keep decisions chain-first',
        choice: 'chain-first',
        options: ['chain-first'],
        status: 'proposed',
        correlationId: 'corr-12',
        source: 'cli',
        tags: ['decision', 'cli'],
        transitionTo: 'accepted',
      }),
      expect.any(Object),
    );
    expect(indexExactSearchBlockMock).toHaveBeenCalledWith(
      expect.objectContaining({
        chain: 'decisions',
        index: 12,
        hash: 'chain-hash-12',
        data: expect.objectContaining({
          id: 'decision-12',
          title: 'Keep decisions chain-first',
        }),
      }),
      expect.any(Object),
    );
    expect(entry).toMatchObject({
      correlationId: 'corr-12',
      chainRef: {
        chain: 'decisions',
        index: 12,
        hash: 'chain-hash-12',
      },
    });
  });
});
