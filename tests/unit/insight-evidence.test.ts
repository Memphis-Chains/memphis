/**
 * The `insights` chain must not copy its sources into itself.
 *
 * ## The failure this exists for
 *
 * `ModelEInsight.evidence` is `Block[]` — the complete source block, with
 * its complete `data.content`. `InsightGenerator.persistInsights` stored
 * the insights verbatim, so every generated insight carried up to five
 * full copies of blocks that already live, in full, in their own chains.
 *
 * Measured on the operator's host: the `insights` chain held 33.4 MB
 * across 402 blocks — 13.2 MB of it inside `evidence[].data`, and another
 * 14.1 MB in the block-level `content` string, which the chain adapter
 * builds by serialising the whole payload. So the duplicated evidence was
 * stored twice over, and the chain grew without bound.
 *
 * ## The rule
 *
 * The chain keeps a REFERENCE to the evidence block — chain, index, hash,
 * prev_hash, timestamp and a short title. The block is still there, in the
 * chain it came from, under the hash it was written with. The report the
 * caller receives still carries the full evidence: only the persisted copy
 * is slimmed.
 */
import { describe, expect, it } from 'vitest';

import { InsightGenerator, toEvidenceReference } from '../../src/cognitive/insight-generator.js';
import type { IStore } from '../../src/cognitive/store.js';
import type { AppendBlockResult } from '../../src/infra/storage/chain-adapter.js';
import type { Block } from '../../src/memory/chain.js';

interface CapturedAppend {
  chain: string;
  data: Record<string, unknown>;
}

function makeBlock(index: number, content: string, tags: string[]): Block {
  return {
    index,
    timestamp: new Date(Date.UTC(2026, 0, 1, 0, 0, index)).toISOString(),
    hash: `${String(index).padStart(64, '0')}`,
    prev_hash: `${String(index - 1).padStart(64, '0')}`,
    chain: 'journal',
    data: { type: 'journal', content, tags },
  };
}

function captureStore(): { store: IStore; captured: CapturedAppend[] } {
  const captured: CapturedAppend[] = [];
  const store: IStore = {
    append: async (chain: string, data: Record<string, unknown>): Promise<AppendBlockResult> => {
      captured.push({ chain, data });
      return { index: 1, hash: 'x', chain, timestamp: new Date().toISOString() };
    },
  };
  return { store, captured };
}

describe('the insights chain stores references, not copies', () => {
  it('keeps a reference to each evidence block', () => {
    const block = makeBlock(7, 'a source block', ['alpha']);
    const reference = toEvidenceReference(block);

    expect(reference).toEqual({
      chain: 'journal',
      index: 7,
      hash: block.hash,
      prev_hash: block.prev_hash,
      timestamp: block.timestamp,
      title: 'a source block',
    });
  });

  it('does not put the source payload into the reference', () => {
    const reference = toEvidenceReference(makeBlock(1, 'x'.repeat(50_000), ['alpha']));

    expect(JSON.stringify(reference).length).toBeLessThan(400);
    expect(reference).not.toHaveProperty('data');
  });

  it('stores references in the chain, while the report keeps the full evidence', async () => {
    const { store, captured } = captureStore();
    const big = 'y'.repeat(40_000);
    const blocks: Block[] = [
      makeBlock(1, big, ['alpha']),
      makeBlock(2, big, ['alpha']),
      makeBlock(3, big, ['alpha']),
    ];

    const generator = new InsightGenerator(blocks, store);
    const report = await generator.generateDailyInsights();

    // The caller still gets the evidence in full.
    expect(report.length).toBeGreaterThan(0);
    expect(report[0]!.evidence.length).toBeGreaterThan(0);
    expect(report[0]!.evidence[0]!.data).toBeDefined();

    // The chain does not.
    expect(captured).toHaveLength(1);
    expect(captured[0]!.chain).toBe('insights');

    const payload = captured[0]!.data;
    expect(payload.evidenceFormat).toBe('reference');

    const stored = payload.insights as Array<{ evidence: Array<Record<string, unknown>> }>;
    expect(stored.length).toBeGreaterThan(0);

    // An insight MAY carry no evidence at all — a bridge insight only
    // links blocks from the window it covers, and the window can be
    // empty. What must never happen is an evidence entry that carries
    // the source payload.
    let referenceCount = 0;
    for (const insight of stored) {
      for (const evidence of insight.evidence) {
        referenceCount += 1;
        expect(evidence).not.toHaveProperty('data');
        expect(evidence.chain).toBe('journal');
        expect(typeof evidence.hash).toBe('string');
        expect(typeof evidence.index).toBe('number');
      }
    }
    expect(referenceCount).toBeGreaterThan(0);

    // The payload is smaller than the evidence it replaced — by orders of
    // magnitude, not by a few percent.
    const storedBytes = JSON.stringify(payload).length;
    const copiedBytes = JSON.stringify({
      ...payload,
      insights: report.map((insight) => ({ ...insight })),
    }).length;
    expect(storedBytes).toBeLessThan(copiedBytes / 10);
  });
});
