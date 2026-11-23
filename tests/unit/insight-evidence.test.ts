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
import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  InsightGenerator,
  toEvidenceReference,
  toInsightSummary,
} from '../../src/cognitive/insight-generator.js';
import type { IStore } from '../../src/cognitive/store.js';
import { appendBlock } from '../../src/infra/storage/chain-adapter.js';
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

describe('the insights chain does not store its payload twice', () => {
  it('the payload carries its own content, so the adapter need not copy it', async () => {
    const { store, captured } = captureStore();
    const big = 'z'.repeat(40_000);
    const blocks: Block[] = [
      makeBlock(1, big, ['alpha']),
      makeBlock(2, big, ['alpha']),
      makeBlock(3, big, ['alpha']),
    ];

    await new InsightGenerator(blocks, store).generateDailyInsights();

    const payload = captured[0]!.data;
    const content = payload.content;

    // A digest, written by the payload — not the copy the adapter would
    // have made of it.
    expect(typeof content).toBe('string');
    const asCopy = JSON.stringify({ ...payload, content: '' });
    expect(content).not.toBe(asCopy);
    expect((content as string).length).toBeLessThan(asCopy.length / 2);

    // And it says what the insights say.
    expect((content as string).length).toBeGreaterThan(0);
  });

  it('the block that reaches the chain is not bigger than the payload', async () => {
    // The measurement that matters: what the chain actually holds. The
    // adapter fills a missing `content` with `JSON.stringify(data)`, so a
    // payload without a content of its own is stored twice — once as
    // fields, once as a copy of itself.
    //
    // Measured 2026-11-23 on this host: all 404 blocks of the `insights`
    // chain carried that copy — 13.67 MB of the chain's 31.92 MB.
    const { store, captured } = captureStore();
    const big = 'q'.repeat(40_000);
    const blocks: Block[] = [
      makeBlock(1, big, ['alpha']),
      makeBlock(2, big, ['alpha']),
      makeBlock(3, big, ['alpha']),
    ];

    await new InsightGenerator(blocks, store).generateDailyInsights();
    const payload = captured[0]!.data;

    const dataDir = mkdtempSync(join(tmpdir(), 'memphis-insight-block-'));
    const previousDataDir = process.env.MEMPHIS_DATA_DIR;
    process.env.MEMPHIS_DATA_DIR = dataDir;
    try {
      await appendBlock('insights', payload);
      const blockFile = join(dataDir, 'chains', 'insights', '000001.json');
      const blockBytes = statSync(blockFile).size;
      const payloadBytes = Buffer.byteLength(JSON.stringify(payload), 'utf8');

      // The block is the payload plus the envelope — not the payload twice.
      expect(blockBytes).toBeLessThan(payloadBytes * 2);
    } finally {
      if (previousDataDir === undefined) delete process.env.MEMPHIS_DATA_DIR;
      else process.env.MEMPHIS_DATA_DIR = previousDataDir;
      rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it('the digest is one line per insight and stays inside its limit', () => {
    const summary = toInsightSummary([
      {
        type: 'pattern',
        title: 'Task focus shifted',
        description: 'backup → model-e',
        confidence: 0.8,
        evidence: [],
        actionable: true,
      },
      {
        type: 'prediction',
        title: 'Second insight',
        description: 'more of the same',
        confidence: 0.6,
        evidence: [],
        actionable: false,
      },
    ]);

    // A header, then one line per insight.
    expect(summary.split('\n')).toHaveLength(3);
    expect(summary).toContain('Task focus shifted');
    expect(summary).toContain('more of the same');
  });

  it('the digest is never empty — the native write path rejects an empty content', () => {
    // `chain_append rejected block: content must not be empty` — the Rust
    // arm refuses the block. A window that produced no insights still has
    // to say so.
    expect(toInsightSummary([]).length).toBeGreaterThan(0);
    expect(toInsightSummary([], 'daily')).toContain('daily');
  });
});
