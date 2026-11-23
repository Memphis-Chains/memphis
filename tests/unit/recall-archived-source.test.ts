import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { resolveRecallSources } from '../../src/infra/memory/exact-search.js';
import { hashBlock } from '../../src/infra/storage/chain-adapter.js';
import { serializeBlockForDisk } from '../../src/infra/storage/chain-file-io.js';
import { rotateChain } from '../../src/infra/storage/chain-rotation.js';

/**
 * The recall must find a block the chain rotation moved aside.
 *
 * ## Why this gate exists
 *
 * The rotation bounds a chain on disk: it moves the old prefix into an
 * archive and keeps the tail live. The blocks are not deleted — the
 * archive restores them, whole.
 *
 * The semantic index is not the chain. It holds the CHUNKS of every block
 * that was ever indexed, and a chunk's id points at `{chain}-{index}`.
 * Nothing told the index that half the chain had moved, so the recall
 * kept finding those chunks — and could not find the blocks behind them,
 * because they are no longer in the live directory.
 *
 * The recall degraded SILENTLY: instead of the block's content it
 * returned the chunk's shortened preview, and said so with
 * `contentSource: "preview"`.
 *
 * > Measured 2026-11-23 on this host, on the real rotation of the
 * > `insights` chain (297 blocks archived): 2 761 of 12 942 chunks in the
 * > live embed index point at blocks that are no longer on disk — 21.3 %
 * > of the index — and 192 of 196 recall hits on archived blocks came
 * > back as an 81-character preview instead of the content.
 *
 * The gate goes through the REAL rotation — not a hand-made archive — and
 * then asks the resolver for a block that is no longer in the live chain.
 * Without the archive fallback it resolves nothing, and the recall would
 * answer with a preview.
 */

const CHAIN = 'journal';
const BLOCK_COUNT = 6;
const KEEP = 2;
const BLOCK_CONTENT_BYTES = 200_000;

const GENESIS_PREV_HASH = '0'.repeat(64);

describe('the recall resolves a block the rotation moved aside', () => {
  let dataDir: string;

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), 'memphis-archive-source-'));
  });

  afterEach(() => {
    rmSync(dataDir, { recursive: true, force: true });
  });

  it('resolves an archived block to its full content', async () => {
    writeFixtureChain(join(dataDir, 'chains', CHAIN), BLOCK_COUNT);

    const rotation = await rotateChain(CHAIN, {
      rawEnv: {
        ...process.env,
        MEMPHIS_DATA_DIR: dataDir,
        MEMPHIS_CHAIN_ROTATION_THRESHOLD_BYTES: String(1024 * 1024),
        MEMPHIS_CHAIN_ROTATION_MIN_KEEP_BLOCKS: String(KEEP),
      },
    });

    expect(rotation.rotated).toBe(true);
    expect(rotation.archivedBlocks).toBe(BLOCK_COUNT - KEEP);

    // Block 1 is in the archive now: its file is gone from the live chain.
    const resolved = resolveRecallSources([{ memoryId: `${CHAIN}-1`, chain: CHAIN }], {
      ...process.env,
      MEMPHIS_DATA_DIR: dataDir,
    });

    const entry = resolved.get(`${CHAIN}:${CHAIN}-1`);
    expect(entry, 'the archived block must still resolve').toBeDefined();
    expect(entry!.chain).toBe(CHAIN);
    expect(entry!.blockIndex).toBe(1);
    expect(entry!.content.length).toBeGreaterThan(100);
  });

  it('still resolves a block that stayed live', async () => {
    writeFixtureChain(join(dataDir, 'chains', CHAIN), BLOCK_COUNT);

    await rotateChain(CHAIN, {
      rawEnv: {
        ...process.env,
        MEMPHIS_DATA_DIR: dataDir,
        MEMPHIS_CHAIN_ROTATION_THRESHOLD_BYTES: String(1024 * 1024),
        MEMPHIS_CHAIN_ROTATION_MIN_KEEP_BLOCKS: String(KEEP),
      },
    });

    const liveIndex = BLOCK_COUNT;
    const resolved = resolveRecallSources(
      [{ memoryId: `${CHAIN}-${liveIndex}`, chain: CHAIN }],
      { ...process.env, MEMPHIS_DATA_DIR: dataDir },
    );

    const entry = resolved.get(`${CHAIN}:${CHAIN}-${liveIndex}`);
    expect(entry, 'the live block must resolve').toBeDefined();
    expect(entry!.blockIndex).toBe(liveIndex);
  });

  it('resolves nothing for a block that was never written', () => {
    writeFixtureChain(join(dataDir, 'chains', CHAIN), BLOCK_COUNT);

    const resolved = resolveRecallSources([{ memoryId: `${CHAIN}-999`, chain: CHAIN }], {
      ...process.env,
      MEMPHIS_DATA_DIR: dataDir,
    });

    expect(resolved.get(`${CHAIN}:${CHAIN}-999`)).toBeUndefined();
  });
});

/**
 * Write the chain the way the adapter writes it: pretty-printed, one file
 * per block, six-digit index, and the bytes go through the one serializer.
 */
function writeFixtureChain(chainDir: string, count: number): void {
  mkdirSync(chainDir, { recursive: true });
  let prevHash = GENESIS_PREV_HASH;
  for (let index = 1; index <= count; index += 1) {
    const withoutHash = {
      index,
      timestamp: new Date(Date.UTC(2026, 0, 1, 0, 0, index)).toISOString(),
      chain: CHAIN,
      data: {
        type: 'journal',
        content: `archived block ${index} — ${'x'.repeat(BLOCK_CONTENT_BYTES)}`,
        tags: [],
      } as Record<string, unknown>,
      prev_hash: prevHash,
    };
    const hash = hashBlock(withoutHash, { createHash } as never);
    writeFileSync(
      join(chainDir, `${String(index).padStart(6, '0')}.json`),
      serializeBlockForDisk({ ...withoutHash, hash }),
      'utf8',
    );
    prevHash = hash;
  }
}
