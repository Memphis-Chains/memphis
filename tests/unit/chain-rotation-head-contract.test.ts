/**
 * A rotated chain must still verify — and the two arms must agree on why.
 *
 * ## The failure this exists for
 *
 * Measured 2026-11-22 on the operator's host: rotating a COPY of the live
 * `system` chain with the repo's own `rotateChain` produced a chain that
 * the runtime then rejected:
 *
 *     [INTERNAL_ERROR] chain 'system' integrity check failed at block
 *     15739 (015739.json): missing genesis block (chain must start at
 *     index 0 or 1)
 *
 * The validators require the first live block to be the genesis block.
 * Rotation archives the old blocks, so the first live block links to a
 * block that is no longer in the directory — and the chain stops
 * verifying.
 *
 * That is why rotation was never enabled. `docs/design/MEMPHIS-CRASH-REBUILD.md`
 * §6 lists the `system` chain growing without bound and notes that
 * "chain rotation exists and is not enabled". The reason was not
 * oversight.
 *
 * ## The rule
 *
 * The live chain does not have to start at genesis. It has to start at a
 * point whose link to the archive can be PROVEN. The rotation head marker
 * carries the index and the hash of the last archived block; the first
 * live block must be exactly one index after it with exactly that
 * `prev_hash`. A marker that does not match is rejected, so a truncated
 * or spliced chain still fails.
 *
 * ## Two arms
 *
 * The TypeScript validator and the Rust one must agree, so the shape is a
 * contract fixture both read:
 * `tests/fixtures/chain-rotation-head-contract.json`. The Rust arm is
 * `crates/memphis-operator/tests/chain_rotation_head_contract.rs`.
 */
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { hashBlock, verifyChainIntegrity } from '../../src/infra/storage/chain-adapter.js';
import {
  isChainRotationHead,
  isValidChainStart,
  parseChainRotationHead,
  ROTATION_HEAD_FILENAME,
  ROTATION_HEAD_FORMAT,
  type ChainRotationHead,
} from '../../src/infra/storage/chain-rotation-head.js';
import { rotateChain } from '../../src/infra/storage/chain-rotation.js';

/**
 * A chain name that does not exist in the live data directory.
 *
 * The regression this file guards against made `rotateChain` resolve the
 * path from `process.env` instead of the caller's environment, so a test
 * that asked to rotate a temporary fixture archived 1052 blocks of the
 * OPERATOR'S LIVE `journal` chain. With a name the live directory does
 * not have, the same regression rotates nothing and fails the assertion
 * instead of damaging live data.
 */
const CHAIN = 'rotation-fixture';

const FIXTURE = JSON.parse(
  readFileSync(join(import.meta.dirname, '..', 'fixtures', 'chain-rotation-head-contract.json'), 'utf8'),
) as {
  format: string;
  filename: string;
  cases: Array<{
    name: string;
    head: ChainRotationHead | null;
    firstLiveBlock: { index: number; prev_hash: string };
    expectValid: boolean;
  }>;
};

describe('the rotation head contract — the two arms agree', () => {
  it('uses the format and the file name the fixture declares', () => {
    expect(ROTATION_HEAD_FORMAT).toBe(FIXTURE.format);
    expect(ROTATION_HEAD_FILENAME).toBe(FIXTURE.filename);
  });

  it('decides every fixture case the way the fixture says', () => {
    for (const testCase of FIXTURE.cases) {
      const head = testCase.head ? parseChainRotationHead(JSON.stringify(testCase.head)) : null;
      const actual = isValidChainStart(
        head,
        testCase.firstLiveBlock.index,
        testCase.firstLiveBlock.prev_hash,
      );
      expect(actual, testCase.name).toBe(testCase.expectValid);
    }
  });

  it('rejects a head whose hash is not a sha256 digest', () => {
    const broken = { ...FIXTURE.cases[0]!.head!, lastArchivedHash: 'not-a-hash' };
    expect(isChainRotationHead(broken)).toBe(false);
    expect(parseChainRotationHead(JSON.stringify(broken))).toBeNull();
  });

  it('rejects a head with the wrong format tag', () => {
    const broken = { ...FIXTURE.cases[0]!.head!, format: 'something-else' };
    expect(parseChainRotationHead(JSON.stringify(broken))).toBeNull();
  });

  it('fails closed on unparseable content', () => {
    expect(parseChainRotationHead('{not json')).toBeNull();
  });
});

describe('a rotated chain still verifies', () => {
  let root: string;
  let chainDir: string;
  let rawEnv: NodeJS.ProcessEnv;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'memphis-rotation-verify-'));
    chainDir = join(root, 'chains', CHAIN);
    mkdirSync(chainDir, { recursive: true });
    rawEnv = { ...process.env, MEMPHIS_DATA_DIR: root };
    writeChain(chainDir, 20);
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('verifies before the rotation and after it', async () => {
    const before = await verifyChainIntegrity(CHAIN, rawEnv);
    expect(before.ok).toBe(true);
    expect(before.blockCount).toBe(20);

    const rotation = await rotateChain(CHAIN, {
      thresholdBytes: 1,
      minKeepBlocks: 5,
      rawEnv,
    });
    expect(rotation.rotated).toBe(true);
    expect(rotation.archivedBlocks).toBe(15);
    expect(rotation.remainingBlocks).toBe(5);

    const after = await verifyChainIntegrity(CHAIN, rawEnv);
    expect(after.ok).toBe(true);
    expect(after.blockCount).toBe(5);
  });

  it('leaves a marker that proves the continuation', async () => {
    await rotateChain(CHAIN, { thresholdBytes: 1, minKeepBlocks: 5, rawEnv });
    const head = parseChainRotationHead(readFileSync(join(chainDir, ROTATION_HEAD_FILENAME), 'utf8'));
    expect(head).not.toBeNull();
    expect(head!.lastArchivedIndex).toBe(15);
    const firstLive = JSON.parse(readFileSync(join(chainDir, '000016.json'), 'utf8')) as {
      prev_hash: string;
    };
    expect(firstLive.prev_hash).toBe(head!.lastArchivedHash);
  });

  it('rejects the chain when the marker does not match the live blocks', async () => {
    await rotateChain(CHAIN, { thresholdBytes: 1, minKeepBlocks: 5, rawEnv });
    const markerPath = join(chainDir, ROTATION_HEAD_FILENAME);
    const head = JSON.parse(readFileSync(markerPath, 'utf8')) as ChainRotationHead;
    writeFileSync(
      markerPath,
      JSON.stringify({ ...head, lastArchivedHash: 'f'.repeat(64) }),
      'utf8',
    );
    await expect(verifyChainIntegrity(CHAIN, rawEnv)).rejects.toThrow(/genesis|continu/i);
  });

  it('rejects the chain when the marker is gone', async () => {
    await rotateChain(CHAIN, { thresholdBytes: 1, minKeepBlocks: 5, rawEnv });
    rmSync(join(chainDir, ROTATION_HEAD_FILENAME));
    await expect(verifyChainIntegrity(CHAIN, rawEnv)).rejects.toThrow(/genesis/i);
  });

  it('archives the blocks instead of deleting them', async () => {
    const rotation = await rotateChain(CHAIN, {
      thresholdBytes: 1,
      minKeepBlocks: 5,
      rawEnv,
    });
    expect(rotation.archivePath).toContain('.jsonl.gz');
    // The archive is gzipped and holds the EXACT contents of the archived
    // block files, so the blocks are recovered byte-for-byte.
    const archived = gunzipSync(readFileSync(rotation.archivePath!)).toString('utf8');
    const blocks = parseJsonStream(archived);
    expect(blocks).toHaveLength(15);
    expect(blocks.map((block) => block.index)).toEqual(
      Array.from({ length: 15 }, (_, offset) => offset + 1),
    );
  });
});

/** Parse a stream of concatenated JSON objects — the archive format. */
function parseJsonStream(text: string): Array<{ index: number }> {
  const blocks: Array<{ index: number }> = [];
  let position = 0;
  while (position < text.length) {
    while (position < text.length && /[\s]/.test(text[position]!)) position += 1;
    if (position >= text.length) break;
    let end = text.indexOf('\n', position);
    if (end === -1) end = text.length;
    const line = text.slice(position, end).trim();
    if (line.length > 0) blocks.push(JSON.parse(line) as { index: number });
    position = end + 1;
  }
  return blocks;
}

/** Write a chain of valid, hash-linked blocks. */
function writeChain(dir: string, count: number): void {
  const crypto = { createHash };
  let prevHash = '0'.repeat(64);
  for (let index = 1; index <= count; index += 1) {
    const block = {
      index,
      timestamp: new Date(Date.UTC(2026, 0, 1, 0, 0, index)).toISOString(),
      chain: CHAIN,
      data: { type: 'journal', content: `block ${index}`, tags: [] },
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
