import { describe, expect, it } from 'vitest';

import type { Block } from '../../src/memory/chain.js';
import { exportTrajectories, mapBlockToEvent } from '../../src/trajectory/exporter.js';

function makeBlock(overrides: Partial<Block> = {}): Block {
  return {
    index: 1,
    timestamp: '2026-04-23T12:00:00.000Z',
    hash: 'h'.repeat(64),
    prev_hash: 'p'.repeat(64),
    chain: 'journal',
    data: {
      content: 'hello',
      tags: [],
      consent: 'exportable',
    },
    ...overrides,
  };
}

describe('trajectory exporter', () => {
  it('reads prev_hash from block-level metadata, not payload', () => {
    const block = makeBlock();
    const mapped = mapBlockToEvent(block, 'journal', 'cli');
    expect(mapped.event).not.toBeNull();
    expect(mapped.event?.provenance.prevHash).toBe('p'.repeat(64));
  });

  it('falls back to data.prev_hash for legacy seeded blocks', () => {
    const block = makeBlock({
      prev_hash: undefined,
      data: { content: 'legacy', prev_hash: 'd'.repeat(64), consent: 'exportable' },
    });
    const mapped = mapBlockToEvent(block, 'journal', 'cli');
    expect(mapped.event?.provenance.prevHash).toBe('d'.repeat(64));
  });

  it('uses all-zeros fallback when no prev_hash anywhere (genesis block)', () => {
    const block = makeBlock({ prev_hash: undefined, data: { content: 'g', consent: 'exportable' } });
    const mapped = mapBlockToEvent(block, 'journal', 'cli');
    expect(mapped.event?.provenance.prevHash).toBe('0'.repeat(64));
  });

  it('captures chain tail hash before consent filter (local-only tip is not hidden)', async () => {
    // Seed chain: [A exportable, B local-only]. Default consent filter is
    // 'exportable' — B gets filtered out but integrity.chainHashes must
    // still reflect B's hash as the true chain tip.
    const blocks: Block[] = [
      makeBlock({ index: 1, hash: 'a'.repeat(64), prev_hash: '0'.repeat(64) }),
      makeBlock({
        index: 2,
        hash: 'b'.repeat(64),
        prev_hash: 'a'.repeat(64),
        data: { content: 'hidden', consent: 'local-only' },
      }),
    ];
    const result = await exportTrajectories({
      chains: ['journal'],
      consent: 'exportable',
      rawEnv: { MEMPHIS_EXPORT_CONFIRM: '1' } as NodeJS.ProcessEnv,
      query: async ({ chain }) => ({ chain: chain!, count: blocks.length, blocks }),
    });
    expect(result.summary.filteredByConsent).toBe(1);
    // Tail must be block B's hash — capturing pre-filter.
    const integrityChainHash = result.trajectories
      .flatMap((t) => Object.entries(t.integrity?.chainHashes ?? {}))
      .find(([chain]) => chain === 'journal')?.[1];
    expect(integrityChainHash).toBe('b'.repeat(64));
  });
});
