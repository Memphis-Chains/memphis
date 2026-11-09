import { createHash } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { readProposals } from '../../src/cognitive/dreaming/proposal-chain.js';
import {
  ReflectionLoop,
  resolveDueReflectionPeriods,
  runDueReflectionCycle,
} from '../../src/infra/runtime/reflection-loop.js';
import type { Block } from '../../src/memory/chain.js';
import { loadMemoryEntries, loadSoulMemory } from '../../src/soul/memory.js';

const { getRecentBlocksMock } = vi.hoisted(() => ({
  getRecentBlocksMock: vi.fn(),
}));

vi.mock('../../src/infra/storage/rust-chain-adapter.js', () => ({
  getRecentBlocks: getRecentBlocksMock,
}));

function block(
  timestamp: string,
  chain: string,
  content: string,
  tags: string[] = [],
  type: string = chain,
): Block {
  return {
    timestamp,
    chain,
    index: 0,
    hash: createHash('sha256').update(`${timestamp}:${chain}:${content}`).digest('hex'),
    data: {
      type,
      content,
      tags,
    },
  };
}

describe('reflection loop runtime', () => {
  beforeEach(() => {
    getRecentBlocksMock.mockReset();
  });

  afterEach(() => {
    delete process.env.MEMPHIS_DATA_DIR;
    delete process.env.MEMPHIS_DATA_DIR;
    delete process.env.RUST_CHAIN_ENABLED;
    delete process.env.COGNITIVE_MODEL_E_REFLECTION_SCHEDULE;
    delete process.env.COGNITIVE_MODEL_E_DEEP_ANALYSIS_DAY;
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it('proposes evidence-backed memory changes without applying them and skips duplicate runs', async () => {
    process.env.MEMPHIS_DATA_DIR = mkdtempSync(join(tmpdir(), 'memphis-reflection-loop-'));
    process.env.RUST_CHAIN_ENABLED = 'false';
    process.env.COGNITIVE_MODEL_E_REFLECTION_SCHEDULE = 'daily';

    getRecentBlocksMock.mockImplementation(async (chain: string) => {
      switch (chain) {
        case 'journal':
          return [
            block('2026-04-08T07:30:00.000Z', 'journal', 'Tightened release checks', ['release']),
            block('2026-04-08T08:00:00.000Z', 'journal', 'Closed one flaky CI edge', ['ci']),
          ];
        case 'decisions':
          return [
            block(
              '2026-04-08T08:15:00.000Z',
              'decisions',
              'Ship release guardrails before feature expansion',
              ['release'],
              'decision',
            ),
          ];
        default:
          return [];
      }
    });

    const first = await runDueReflectionCycle({
      rawEnv: process.env,
      now: new Date('2026-04-08T10:00:00.000Z'),
    });

    expect(first).toMatchObject({
      skipped: false,
      periods: ['daily'],
      reflectionCount: 1,
      soulMemoryUpdated: false,
      recentDecisionCount: 1,
    });

    const memory = loadSoulMemory(process.env);
    expect(memory).toBeNull();
    const proposals = await readProposals(process.env);
    expect(proposals).toHaveLength(1);
    expect(proposals[0]).toMatchObject({ status: 'pending', kind: 'memory.update' });
    expect(proposals[0].basedOn.chainBlockHashes.length).toBeGreaterThan(0);
    expect(proposals[0].patch).toMatchObject({
      context: { recentDecisions: ['Ship release guardrails before feature expansion'] },
    });

    const memoryEntries = loadMemoryEntries(process.env);
    expect(memoryEntries).toEqual(
      expect.arrayContaining([expect.objectContaining({ actionType: 'insight' })]),
    );

    const second = await runDueReflectionCycle({
      rawEnv: process.env,
      now: new Date('2026-04-08T16:30:00.000Z'),
    });

    expect(second).toMatchObject({
      skipped: true,
      skippedReason: 'not-due',
      reflectionCount: 0,
      insightCount: 0,
    });
  });

  it('resolves weekly runs from the configured reflection boundary', () => {
    const rawEnv = {
      COGNITIVE_MODEL_E_REFLECTION_SCHEDULE: 'weekly',
      COGNITIVE_MODEL_E_DEEP_ANALYSIS_DAY: '1',
    } as NodeJS.ProcessEnv;

    expect(resolveDueReflectionPeriods(rawEnv, new Date('2026-04-06T08:00:00.000Z'), {})).toEqual([
      'weekly',
    ]);
    expect(resolveDueReflectionPeriods(rawEnv, new Date('2026-04-07T09:00:00.000Z'), {})).toEqual([
      'weekly',
    ]);
    expect(
      resolveDueReflectionPeriods(rawEnv, new Date('2026-04-07T09:00:00.000Z'), {
        lastWeeklyRunAt: '2026-04-06T12:00:00.000Z',
      }),
    ).toEqual([]);
  });

  it('starts after the initial delay and repeats on the configured interval', async () => {
    vi.useFakeTimers();
    const runCycle = vi.fn().mockResolvedValue({
      generatedAt: '2026-04-08T10:00:00.000Z',
      trigger: 'lifecycle',
      periods: ['daily'],
      reflectionCount: 1,
      insightCount: 2,
      recentDecisionCount: 1,
      soulMemoryUpdated: true,
      skipped: false,
    });

    const loop = new ReflectionLoop({
      rawEnv: { MEMPHIS_REFLECTION_ENABLED: 'true' },
      initialDelayMs: 1_000,
      intervalMs: 2_000,
      runCycle,
    });

    expect(loop.start()).toBe(true);

    await vi.advanceTimersByTimeAsync(999);
    expect(runCycle).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);
    expect(runCycle).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(4_000);
    expect(runCycle).toHaveBeenCalledTimes(3);

    loop.stop();
  });

  it('does not start when disabled by env', () => {
    const runCycle = vi.fn();
    const loop = new ReflectionLoop({
      rawEnv: { MEMPHIS_REFLECTION_ENABLED: 'false' },
      runCycle,
    });

    expect(loop.start()).toBe(false);
    expect(runCycle).not.toHaveBeenCalled();
  });
});
