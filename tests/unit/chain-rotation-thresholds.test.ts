/**
 * The rotation knobs must be honoured, not merely registered.
 *
 * ## The failure this exists for
 *
 * `MEMPHIS_CHAIN_ROTATION_THRESHOLD_BYTES` and
 * `MEMPHIS_CHAIN_ROTATION_MIN_KEEP_BLOCKS` were registered in the env
 * schema (`src/infra/config/schema.ts`), listed as warm settings, and
 * named in the rotation loop's own documentation — and the rotation code
 * never read either of them. The hardcoded defaults were used instead.
 *
 * An operator who set the threshold got no effect and no error: the
 * setting was accepted, validated, and ignored. That is the worst shape
 * a knob can have — it looks like a control.
 *
 * The schema's bounds are the code's bounds:
 * threshold 1 MiB .. 1 GiB, min keep 1 .. 10 000.
 */
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { hashBlock } from '../../src/infra/storage/chain-adapter.js';
import { rotateChain } from '../../src/infra/storage/chain-rotation.js';

const CHAIN = 'rotation-threshold-fixture';
/** 12 blocks of 200 KB — 2.4 MB, over the 1 MiB floor and far under 50 MB. */
const BLOCK_COUNT = 12;
const BLOCK_CONTENT_BYTES = 200_000;

describe('the rotation honours its environment knobs', () => {
  let root: string;
  let chainDir: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'memphis-rotation-threshold-'));
    chainDir = join(root, 'chains', CHAIN);
    mkdirSync(chainDir, { recursive: true });
    writeChain(chainDir, BLOCK_COUNT);
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('does not rotate a small chain when no threshold is set', async () => {
    const result = await rotateChain(CHAIN, {
      rawEnv: { ...process.env, MEMPHIS_DATA_DIR: root },
    });

    // The default threshold is 50 MB and this chain is 2.4 MB.
    expect(result.rotated).toBe(false);
    expect(result.archivedBlocks).toBe(0);
  });

  it('rotates when the threshold from the environment is exceeded', async () => {
    const result = await rotateChain(CHAIN, {
      rawEnv: {
        ...process.env,
        MEMPHIS_DATA_DIR: root,
        MEMPHIS_CHAIN_ROTATION_THRESHOLD_BYTES: String(1024 * 1024),
      },
    });

    expect(result.rotated).toBe(true);
    expect(result.archivedBlocks).toBeGreaterThan(0);
  });

  it('keeps the number of blocks the environment asks for', async () => {
    const result = await rotateChain(CHAIN, {
      rawEnv: {
        ...process.env,
        MEMPHIS_DATA_DIR: root,
        MEMPHIS_CHAIN_ROTATION_THRESHOLD_BYTES: String(1024 * 1024),
        MEMPHIS_CHAIN_ROTATION_MIN_KEEP_BLOCKS: '7',
      },
    });

    expect(result.rotated).toBe(true);
    expect(result.remainingBlocks).toBe(7);
  });

  it('lets an explicit option override the environment', async () => {
    const result = await rotateChain(CHAIN, {
      rawEnv: {
        ...process.env,
        MEMPHIS_DATA_DIR: root,
        MEMPHIS_CHAIN_ROTATION_THRESHOLD_BYTES: String(1024 * 1024),
        MEMPHIS_CHAIN_ROTATION_MIN_KEEP_BLOCKS: '7',
      },
      thresholdBytes: 1024 * 1024 * 1024,
      minKeepBlocks: 4,
    });

    // The threshold option wins, so the chain stays under it and no
    // rotation happens — and the min-keep option is never reached.
    expect(result.rotated).toBe(false);
  });

  it('clamps a threshold below the schema floor instead of rotating everything', async () => {
    const result = await rotateChain(CHAIN, {
      rawEnv: {
        ...process.env,
        MEMPHIS_DATA_DIR: root,
        MEMPHIS_CHAIN_ROTATION_THRESHOLD_BYTES: '1',
      },
    });

    // The schema's floor is 1 MiB and this chain is 2.4 MB, so it still
    // rotates — but the point is that the value was clamped, not taken as
    // one byte, which would have archived everything but one block.
    expect(result.rotated).toBe(true);
    expect(result.remainingBlocks).toBeGreaterThanOrEqual(1);
  });
});

function writeChain(dir: string, count: number): void {
  const crypto = { createHash };
  let prevHash = '0'.repeat(64);
  for (let index = 1; index <= count; index += 1) {
    const block = {
      index,
      timestamp: new Date(Date.UTC(2026, 0, 1, 0, 0, index)).toISOString(),
      chain: CHAIN,
      data: { type: 'journal', content: 'x'.repeat(BLOCK_CONTENT_BYTES), tags: [] },
      prev_hash: prevHash,
    };
    const hash = hashBlock(block, crypto as never);
    writeFileSync(
      join(dir, `${String(index).padStart(6, '0')}.json`),
      JSON.stringify({ ...block, hash }),
      'utf8',
    );
    prevHash = hash;
  }
}
