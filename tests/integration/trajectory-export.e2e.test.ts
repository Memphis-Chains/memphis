/**
 * End-to-end integration test for the trajectory export loop.
 *
 * Proves the write-path → export-path contract from N8 + N8.2 + N9
 * actually round-trips on disk, not just in unit-test mocks:
 *
 *   1. `storeDurableMemory()` stamps turn_id + conversation_id on a
 *      real block file under MEMPHIS_DATA_DIR/chains/journal/.
 *   2. `runMemphisChainQuery()` reads those blocks back via the
 *      filesystem chain adapter (TS fallback mode).
 *   3. `exportTrajectories()` groups by conversation_id so a
 *      multi-turn conversation becomes ONE trajectory, not N 1-event
 *      fragments.
 *
 * This is the confidence check on the "foundation loop" — any drift
 * between what writers stamp and what the exporter reads surfaces
 * here. Unit tests mock the chain adapter; this one hits the disk.
 */
import { randomUUID } from 'node:crypto';
import { mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { storeDurableMemory } from '../../src/infra/memory/durable-memory.js';
import { runMemphisChainQuery } from '../../src/mcp/tools/chain-query.js';
import { exportTrajectories } from '../../src/trajectory/exporter.js';

function makeTmpDir(): string {
  const dir = join(tmpdir(), `memphis-trajectory-e2e-${randomUUID()}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

describe('trajectory export E2E (N8.2 + N9)', () => {
  let dataDir: string;
  let originalDataDir: string | undefined;
  let originalRustEnabled: string | undefined;

  beforeEach(() => {
    dataDir = makeTmpDir();
    // All adapters read process.env at call time, so set + restore
    // rather than thread env through deps on every helper.
    originalDataDir = process.env.MEMPHIS_DATA_DIR;
    originalRustEnabled = process.env.RUST_CHAIN_ENABLED;
    process.env.MEMPHIS_DATA_DIR = dataDir;
    process.env.RUST_CHAIN_ENABLED = 'false';
  });

  afterEach(() => {
    if (originalDataDir === undefined) delete process.env.MEMPHIS_DATA_DIR;
    else process.env.MEMPHIS_DATA_DIR = originalDataDir;
    if (originalRustEnabled === undefined) delete process.env.RUST_CHAIN_ENABLED;
    else process.env.RUST_CHAIN_ENABLED = originalRustEnabled;
    rmSync(dataDir, { recursive: true, force: true });
  });

  it('writes turn_id + conversation_id to disk and exports as a multi-turn trajectory', async () => {
    const conversationId = 'conv-e2e-xyz';
    const turn1Id = 'turn-001';
    const turn2Id = 'turn-002';

    // Two turns of the same conversation, plus an unrelated turn from
    // a different conversation to confirm grouping isolates them.
    await storeDurableMemory({
      content: 'user asked about rebasing',
      chain: 'journal',
      turnId: turn1Id,
      conversationId,
      consent: 'exportable',
      source: 'cli.chat',
    });
    await storeDurableMemory({
      content: 'assistant explained interactive rebase',
      chain: 'journal',
      turnId: turn2Id,
      conversationId,
      consent: 'exportable',
      source: 'cli.chat',
    });
    await storeDurableMemory({
      content: 'unrelated scheduler tick',
      chain: 'journal',
      turnId: 'turn-unrelated',
      consent: 'exportable',
      source: 'scheduler',
    });

    // Read back raw blocks first so we prove the write-side stamping
    // actually landed on disk (bypassing the exporter so the test
    // catches any future exporter regression without conflating it
    // with a write-path regression).
    const out = await runMemphisChainQuery({ chain: 'journal', limit: 10 });
    const stampedTurnIds = out.blocks
      .map((b) => (b.data as Record<string, unknown>)?.turn_id)
      .filter((v): v is string => typeof v === 'string');
    const stampedConvIds = out.blocks
      .map((b) => (b.data as Record<string, unknown>)?.conversation_id)
      .filter((v): v is string => typeof v === 'string');
    expect(stampedTurnIds).toEqual(expect.arrayContaining([turn1Id, turn2Id]));
    expect(stampedConvIds).toEqual([conversationId, conversationId]);

    // Now run the exporter. Two blocks with the same conversation_id
    // must collapse into ONE trajectory; the unrelated turn becomes
    // its own per-turn bucket.
    const result = await exportTrajectories({
      chains: ['journal'],
      consent: 'exportable',
      rawEnv: { MEMPHIS_EXPORT_CONFIRM: '1' } as NodeJS.ProcessEnv,
    });
    expect(result.trajectories.length).toBe(2);
    const sizes = result.trajectories.map((t) => t.events.length).sort();
    expect(sizes).toEqual([1, 2]);
    const multiTurn = result.trajectories.find((t) => t.events.length === 2);
    expect(multiTurn?.sessionId).toBe(`conversation:${conversationId}`);
  });

  it('omitting conversation_id leaves writer in per-turn mode (v1 documented behavior)', async () => {
    await storeDurableMemory({
      content: 'turn 1, no conversation binding',
      chain: 'journal',
      turnId: 'turn-a',
      consent: 'exportable',
      source: 'cli.chat',
    });
    await storeDurableMemory({
      content: 'turn 2, no conversation binding',
      chain: 'journal',
      turnId: 'turn-b',
      consent: 'exportable',
      source: 'cli.chat',
    });

    const result = await exportTrajectories({
      chains: ['journal'],
      consent: 'exportable',
      rawEnv: { MEMPHIS_EXPORT_CONFIRM: '1' } as NodeJS.ProcessEnv,
    });
    // Without conversation_id, each turn becomes its own trajectory
    // — the v1 documented fallback per `sessionFromEvent`.
    expect(result.trajectories.length).toBe(2);
    for (const t of result.trajectories) {
      expect(t.events.length).toBe(1);
    }
  });
});
