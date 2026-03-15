import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { runCli } from '../helpers/cli.js';

describe('CLI soul commands', () => {
  it('runs soul replay and soul step via rust bridge', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'memphis-cli-soul-'));
    const bridgePath = join(dir, 'bridge.cjs');
    const blocksPath = join(dir, 'blocks.json');

    writeFileSync(
      bridgePath,
      `module.exports = {
  chain_append: () => JSON.stringify({ ok: true, data: { appended: true, length: 1, chain: [] } }),
  chain_validate: () => JSON.stringify({ ok: true, data: { valid: true } }),
  chain_query: () => JSON.stringify({ ok: true, data: { count: 0, blocks: [] } }),
  soul_replay: (_chain, blocksJson) => {
    const blocks = JSON.parse(blocksJson);
    return JSON.stringify({
      ok: true,
      data: {
        accepted: blocks.length,
        rejected: 0,
        errors: [],
        snapshot: { blocks: blocks.length, last_hash: blocks.at(-1)?.hash ?? null, state_hash: 'state-hash' }
      }
    });
  },
  soul_loop_step: (stateJson, actionJson) => {
    const state = JSON.parse(stateJson);
    const action = JSON.parse(actionJson);
    if (action.type === 'complete') {
      state.completed = true;
      state.steps += 1;
    }
    return JSON.stringify({ ok: true, data: { applied: true, state } });
  }
};`,
      'utf8',
    );

    writeFileSync(
      blocksPath,
      JSON.stringify([
        {
          index: 0,
          timestamp: '2026-03-12T00:00:00Z',
          chain: 'system',
          data: { block_type: 'system_event', content: 'boot', tags: ['boot'] },
          prev_hash: '0'.repeat(64),
          hash: 'a'.repeat(64),
        },
      ]),
      'utf8',
    );

    const env = {
      RUST_CHAIN_ENABLED: 'true',
      RUST_CHAIN_BRIDGE_PATH: bridgePath,
      HOME: dir,
    } as NodeJS.ProcessEnv;

    const replayOut = await runCli(
      ['soul', 'replay', '--chain', 'system', '--file', blocksPath, '--json'],
      { env },
    );
    const replay = JSON.parse(replayOut) as {
      ok: boolean;
      count: number;
      report: { accepted: number; snapshot: { state_hash: string } };
    };
    expect(replay.ok).toBe(true);
    expect(replay.count).toBe(1);
    expect(replay.report.accepted).toBe(1);
    expect(replay.report.snapshot.state_hash).toBe('state-hash');

    const loopOut = await runCli(
      [
        'soul',
        'step',
        '--state',
        '{"steps":0,"tool_calls":0,"wait_ms":0,"errors":0,"completed":false,"halt_reason":null}',
        '--action',
        '{"type":"complete","data":{"summary":"done"}}',
        '--json',
      ],
      { env },
    );
    const loop = JSON.parse(loopOut) as {
      ok: boolean;
      result: { applied: boolean; state: { completed: boolean; steps: number } };
    };
    expect(loop.ok).toBe(true);
    expect(loop.result.applied).toBe(true);
    expect(loop.result.state.completed).toBe(true);
    expect(loop.result.state.steps).toBe(1);
  });
});
