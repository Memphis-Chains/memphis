/**
 * Rotation must publish under the chains write lock.
 *
 * ## The failure this exists for
 *
 * `rotateChain` read the block list, wrote the archive, DELETED the
 * archived blocks and only then wrote the rotation head marker — with no
 * lock at all. Between the delete and the marker write the live chain
 * starts at an index above 1 and carries no proof that it continues an
 * archive, and every validator rejects that shape as "missing genesis
 * block".
 *
 * That window was open to any reader, and to any append: the append path
 * takes the chains write lock (`chain-write-lock.ts`, shared with the
 * native writer through `chain_write_lock.rs`), and the rotation took
 * none. An append that landed inside the window would have written a
 * block onto a chain that was, for those milliseconds, invalid.
 *
 * The fix splits the rotation in two:
 *
 * - phase 1 writes the gzipped archive — outside the lock, because
 *   compressing 62 MB would otherwise make appends time out against the
 *   lock's 10 second deadline,
 * - phase 2 publishes the archive, removes the originals and writes the
 *   marker — inside the lock, as one critical section.
 *
 * ## What this test measures
 *
 * It replaces the write lock with a recording one and watches what
 * happens while the lock is held. The assertions are about ORDER, not
 * about timing: the archived blocks and the marker must both appear
 * inside the critical section, and the lock must be the CHAINS
 * directory — the same one the append path takes, not the chain
 * directory.
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const CHAIN = 'rotation-lock-fixture';

interface LockObservation {
  /** The directory the lock was taken on. */
  directory: string;
  /** Block files present when the lock was acquired. */
  blocksBefore: string[];
  /** Block files present when the lock was released. */
  blocksAfter: string[];
  /** Whether the rotation head marker existed when the lock was acquired. */
  markerBefore: boolean;
  /** Whether the rotation head marker existed when the lock was released. */
  markerAfter: boolean;
}

const observations: LockObservation[] = [];
let observedChainDir = '';

vi.mock('../../src/infra/storage/chain-write-lock.js', () => ({
  withChainWriteLock: async (directory: string, write: () => Promise<unknown>) => {
    const blocksBefore = readdirSync(observedChainDir).filter((file) => file.endsWith('.json'));
    const markerBefore = existsSync(join(observedChainDir, 'chain-rotation.head'));
    const result = await write();
    const blocksAfter = readdirSync(observedChainDir).filter((file) => file.endsWith('.json'));
    const markerAfter = existsSync(join(observedChainDir, 'chain-rotation.head'));
    observations.push({ directory, blocksBefore, blocksAfter, markerBefore, markerAfter });
    return result;
  },
}));

const { hashBlock } = await import('../../src/infra/storage/chain-adapter.js');
const { rotateChain } = await import('../../src/infra/storage/chain-rotation.js');

describe('the rotation publishes under the chains write lock', () => {
  let root: string;
  let chainsDir: string;
  let chainDir: string;
  let rawEnv: NodeJS.ProcessEnv;

  beforeEach(() => {
    observations.length = 0;
    root = mkdtempSync(join(tmpdir(), 'memphis-rotation-lock-'));
    chainsDir = join(root, 'chains');
    chainDir = join(chainsDir, CHAIN);
    mkdirSync(chainDir, { recursive: true });
    rawEnv = { ...process.env, MEMPHIS_DATA_DIR: root };
    observedChainDir = chainDir;
    writeChain(chainDir, 12);
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('takes the chains write lock — the same lock the append path takes', async () => {
    await rotateChain(CHAIN, { rawEnv, thresholdBytes: 1, minKeepBlocks: 3 });

    expect(observations).toHaveLength(1);
    // NOT the chain directory: the append path locks the chains directory,
    // so a lock on the chain directory would not exclude an append.
    expect(observations[0]!.directory).toBe(chainsDir);
  });

  it('removes the archived blocks and writes the marker inside the critical section', async () => {
    await rotateChain(CHAIN, { rawEnv, thresholdBytes: 1, minKeepBlocks: 3 });

    const observation = observations[0]!;
    // Nothing is published before the lock is taken.
    expect(observation.blocksBefore).toHaveLength(12);
    expect(observation.markerBefore).toBe(false);

    // Everything is published before the lock is released.
    expect(observation.blocksAfter).toHaveLength(3);
    expect(observation.markerAfter).toBe(true);
  });

  it('leaves the chain verifiable after the rotation', async () => {
    await rotateChain(CHAIN, { rawEnv, thresholdBytes: 1, minKeepBlocks: 3 });

    const { verifyChainIntegrity } = await import('../../src/infra/storage/chain-adapter.js');
    const result = await verifyChainIntegrity(CHAIN, rawEnv);
    expect(result.ok).toBe(true);
    expect(result.blockCount).toBe(3);
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
      data: { type: 'journal', content: `block ${index}`, tags: [] },
      prev_hash: prevHash,
    };
    const hash = hashBlock(block, crypto as never);
    writeFileSync(join(dir, `${String(index).padStart(6, '0')}.json`), JSON.stringify({ ...block, hash }), 'utf8');
    prevHash = hash;
  }
}
