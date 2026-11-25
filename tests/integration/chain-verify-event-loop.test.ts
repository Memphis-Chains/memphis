/**
 * THE GATE: the chain verifier must never freeze the runtime.
 *
 * WHY THIS IS ITS OWN FILE
 *
 * The drill's job is to answer "is the archive restorable?". The question it
 * never got to answer was "did the runtime stay alive while it found out?".
 *
 * The tar rule was repaired first (PR #796): the drill's tar is asynchronous
 * now, and a stop aimed at the drill is answered in 1 ms. But the drill does
 * not only extract — it VERIFIES, and the verification was the other half of
 * the pause. The verifier's cost is CPU and I/O per block, and it used to
 * run in one uninterrupted burst. A loop that is asleep cannot dispatch a
 * signal handler, and that is the mechanism that turned E-07's stop into a
 * SIGKILL.
 *
 * MEASURED on this host, 2026-11-25, on the LIVE corpus (the `patterns`
 * chain, 5 544 blocks), three runs each:
 *
 *   before: the longest silence 1 029 / 988 / 963 ms, the heartbeat 5 of ~100
 *   after:  the longest silence   55 /  44 /  39 ms, the heartbeat 79 of 98
 *
 * and the verification itself took the same time: 2 047 ms before, 1 947 ms
 * after (medians). In the REAL drill, on the real archive
 * (`scheduled-2026-11-25-11-42.tar.gz`), the longest silence fell from
 * **921 ms to 115 ms** and the drill took the same time (15 588 ms →
 * 15 178 ms).
 *
 * HOW THE GATE WORKS
 *
 * A synthetic chain with correct hashes is written to a temporary data
 * directory, and a 20 ms heartbeat runs for the whole verification. Every
 * beat is a question the loop was asked: "are you still there?". A loop that
 * is asleep cannot answer, and the number of questions that went UNANSWERED
 * is the property that matters — the runtime has to stay reachable while it
 * works.
 *
 * The assertion is about the LOOP, not about a duration: the questions
 * answered are counted against the questions ASKED — the elapsed time
 * divided by the heartbeat — so the gate scales with the machine instead of
 * carrying an absolute threshold that drifts with the hardware. There is no
 * timing to be flaky about, and the gate CAN fail: it was run against the
 * pre-fix code, where it fails.
 *
 * MEASURED on this host, 2026-11-25, on the 5 000-block corpus this gate
 * builds:
 *
 *   before:   5 of 48 questions answered (10 %) → FAILS
 *   after:   38 of 40 questions answered (95 %) → passes
 */
import * as crypto from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { hashBlock, verifyChainIntegrity } from '../../src/infra/storage/chain-adapter.js';

/** How often the heartbeat asks the loop whether it is still there. */
const HEARTBEAT_MS = 20;

/**
 * How many of the asked questions the loop has to answer.
 *
 * A third. MEASURED on this host, 2026-11-25: the pre-fix verifier answered
 * 10 % of them, the repaired one 95 %. A third sits between the two with
 * room on both sides.
 */
const MIN_ANSWERED_SHARE = 1 / 3;

const roots: string[] = [];
afterEach(() => roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true })));

/**
 * A chain of `count` blocks whose hashes are all CORRECT, so the verifier
 * passes instead of failing on the first block.
 *
 * The blocks are linked the way the writer links them: each block's
 * `prev_hash` is the previous block's hash, and the chain starts at index 1
 * with an empty `prev_hash` — the genesis the verifier accepts.
 *
 * THE BLOCKS ARE THE SIZE OF REAL BLOCKS, and that is load-bearing. The
 * verifier's cost is dominated by the canonical serialisation, the SHA-256
 * and the read of each block, so a block of a few dozen bytes costs a
 * fraction of what a real one costs — and a gate built on toy blocks would
 * measure a cost the runtime never pays. MEASURED on this host, 2026-11-25:
 * the blocks of the `patterns` chain average **1 883 bytes**.
 */
function syntheticChain(dataDir: string, count: number): void {
  const chainDir = join(dataDir, 'chains', 'journal');
  mkdirSync(chainDir, { recursive: true });
  let prevHash = '';
  for (let index = 1; index <= count; index += 1) {
    const block = {
      index,
      timestamp: '2026-11-25T00:00:00.000Z',
      chain: 'journal',
      prev_hash: prevHash,
      data: { type: 'journal', content: `block-${index} ${'x'.repeat(1_700)}` },
    };
    const hash = hashBlock(block, crypto);
    writeFileSync(
      join(chainDir, `${String(index).padStart(6, '0')}.json`),
      JSON.stringify({ ...block, hash }),
    );
    prevHash = hash;
  }
}

describe('the chain verifier never freezes the runtime', () => {
  it('keeps the event loop turning while it verifies a long chain', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'memphis-verify-loop-'));
    roots.push(dataDir);
    // Long enough that the verification is measured, not guessed: on this
    // host, 5 000 blocks are ~800 ms of work.
    syntheticChain(dataDir, 5_000);

    const ticks: number[] = [];
    const heartbeat = setInterval(() => ticks.push(Date.now()), HEARTBEAT_MS);
    let blockCount = 0;
    let elapsedMs = 0;
    try {
      const started = Date.now();
      const result = await verifyChainIntegrity('journal', { MEMPHIS_DATA_DIR: dataDir });
      elapsedMs = Date.now() - started;
      blockCount = result.blockCount;
    } finally {
      clearInterval(heartbeat);
    }

    // The verification itself has to be real: a verifier that checks nothing
    // would also keep the loop turning.
    expect(blockCount).toBe(5_000);

    // How many questions the heartbeat asked, and how many the loop answered.
    const asked = Math.floor(elapsedMs / HEARTBEAT_MS);
    expect(asked).toBeGreaterThan(0);
    expect(ticks.length / asked).toBeGreaterThan(MIN_ANSWERED_SHARE);
  }, 120_000);
});
