import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { NapiChainAdapter } from '../../src/infra/storage/rust-chain-adapter.js';

describe('rust chain adapter soul bridge', () => {
  it('replays blocks and advances loop state via bridge envelope', () => {
    const dir = mkdtempSync(join(tmpdir(), 'memphis-soul-bridge-'));
    const bridgePath = join(dir, 'bridge.cjs');
    writeFileSync(
      bridgePath,
      `module.exports = {
  soul_replay: (_chainName, blocksJson) => {
    const blocks = JSON.parse(blocksJson);
    return JSON.stringify({
      ok: true,
      data: {
        accepted: blocks.length,
        rejected: 0,
        errors: [],
        snapshot: {
          blocks: blocks.length,
          last_hash: blocks.at(-1)?.hash ?? null,
          state_hash: "state-hash-1"
        }
      }
    });
  },
  soul_loop_step: (stateJson, actionJson) => {
    const state = JSON.parse(stateJson);
    const action = JSON.parse(actionJson);
    if (action.type === "complete") {
      state.completed = true;
      state.steps += 1;
      return JSON.stringify({ ok: true, data: { applied: true, state } });
    }
    return JSON.stringify({ ok: true, data: { applied: false, reason: "unsupported", state } });
  }
};`,
      'utf8',
    );

    const adapter = new NapiChainAdapter({
      RUST_CHAIN_ENABLED: 'true',
      RUST_CHAIN_BRIDGE_PATH: bridgePath,
    } as NodeJS.ProcessEnv);

    const replay = adapter.soulReplay('system', [
      {
        index: 0,
        timestamp: '2026-03-12T00:00:00Z',
        chain: 'system',
        data: { block_type: 'system_event', content: 'boot', tags: ['boot'] },
        prev_hash: '0'.repeat(64),
        hash: 'a'.repeat(64),
      },
    ]);
    expect(replay.accepted).toBe(1);
    expect(replay.rejected).toBe(0);
    expect(replay.snapshot.last_hash).toBe('a'.repeat(64));

    const loop = adapter.soulLoopStep(
      {
        steps: 0,
        tool_calls: 0,
        wait_ms: 0,
        errors: 0,
        completed: false,
        halt_reason: null,
      },
      { type: 'complete', data: { summary: 'done' } },
    );
    expect(loop.applied).toBe(true);
    expect(loop.state.completed).toBe(true);
    expect(loop.state.steps).toBe(1);
  });

  it('throws when soul loop function is missing from bridge', () => {
    const dir = mkdtempSync(join(tmpdir(), 'memphis-soul-bridge-missing-'));
    const bridgePath = join(dir, 'bridge.cjs');
    writeFileSync(
      bridgePath,
      `module.exports = { soul_replay: () => JSON.stringify({ ok: true, data: { accepted: 0, rejected: 0, errors: [], snapshot: { blocks: 0, last_hash: null, state_hash: "empty" } } }) };`,
      'utf8',
    );

    const adapter = new NapiChainAdapter({
      RUST_CHAIN_ENABLED: 'true',
      RUST_CHAIN_BRIDGE_PATH: bridgePath,
    } as NodeJS.ProcessEnv);

    expect(() =>
      adapter.soulLoopStep(
        {
          steps: 0,
          tool_calls: 0,
          wait_ms: 0,
          errors: 0,
          completed: false,
          halt_reason: null,
        },
        { type: 'wait', data: { duration_ms: 10 } },
      ),
    ).toThrow(/soul_loop_step not available/);
  });
});
