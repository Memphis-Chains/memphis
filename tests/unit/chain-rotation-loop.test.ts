import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  MAX_INTERVAL_MS,
  MIN_INTERVAL_MS,
  startChainRotationLoop,
} from '../../src/infra/runtime/chain-rotation-loop.js';
import type { ChainRotationResult } from '../../src/infra/storage/chain-rotation.js';

const SAMPLE_RESULT_NOOP: ChainRotationResult = {
  chain: 'memphis',
  rotated: false,
  archivedBlocks: 0,
  remainingBlocks: 5,
  dirSizeBytes: 1024,
};

const SAMPLE_RESULT_ROTATED: ChainRotationResult = {
  chain: 'memphis',
  rotated: true,
  archivedBlocks: 90,
  archivePath: '/tmp/archive.jsonl.gz',
  remainingBlocks: 10,
  dirSizeBytes: 2048,
};

describe('startChainRotationLoop (deferred item #5)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('does NOT start when MEMPHIS_CHAIN_ROTATE_INTERVAL_MS is unset', () => {
    const rotateFn = vi.fn(async (): Promise<ChainRotationResult[]> => [SAMPLE_RESULT_NOOP]);
    const handle = startChainRotationLoop({
      rawEnv: {} as NodeJS.ProcessEnv,
      rotateFn,
    });
    vi.advanceTimersByTime(120_000);
    expect(rotateFn).not.toHaveBeenCalled();
    handle.stop();
  });

  it('refuses intervals below the floor (< 60s)', () => {
    const rotateFn = vi.fn(async () => [SAMPLE_RESULT_NOOP]);
    startChainRotationLoop({
      rawEnv: { MEMPHIS_CHAIN_ROTATE_INTERVAL_MS: '5000' } as NodeJS.ProcessEnv,
      rotateFn,
    });
    vi.advanceTimersByTime(120_000);
    expect(rotateFn).not.toHaveBeenCalled();
  });

  it('refuses intervals above the ceiling (> 24h)', () => {
    const rotateFn = vi.fn(async () => [SAMPLE_RESULT_NOOP]);
    startChainRotationLoop({
      rawEnv: {
        MEMPHIS_CHAIN_ROTATE_INTERVAL_MS: String(MAX_INTERVAL_MS + 1),
      } as NodeJS.ProcessEnv,
      rotateFn,
    });
    vi.advanceTimersByTime(120_000);
    expect(rotateFn).not.toHaveBeenCalled();
  });

  it('ticks at the configured interval when env is set', () => {
    const rotateFn = vi.fn(async () => [SAMPLE_RESULT_NOOP]);
    const handle = startChainRotationLoop({
      rawEnv: {
        MEMPHIS_CHAIN_ROTATE_INTERVAL_MS: String(MIN_INTERVAL_MS),
      } as NodeJS.ProcessEnv,
      rotateFn,
    });
    vi.advanceTimersByTime(MIN_INTERVAL_MS * 3);
    expect(rotateFn.mock.calls.length).toBeGreaterThanOrEqual(3);
    handle.stop();
  });

  it('records lastResults on success', async () => {
    const rotateFn = vi.fn(async () => [SAMPLE_RESULT_ROTATED]);
    const handle = startChainRotationLoop({
      rawEnv: {} as NodeJS.ProcessEnv,
      rotateFn,
    });
    const state = await handle.tickNow();
    expect(state.lastResults).toEqual([SAMPLE_RESULT_ROTATED]);
    expect(state.lastError).toBeUndefined();
    expect(state.lastTickAt).toBeTruthy();
  });

  it('records lastError on failure and continues ticking', async () => {
    let calls = 0;
    const rotateFn = vi.fn(async () => {
      calls += 1;
      if (calls === 1) throw new Error('disk full');
      return [SAMPLE_RESULT_NOOP];
    });
    const handle = startChainRotationLoop({
      rawEnv: {} as NodeJS.ProcessEnv,
      rotateFn,
    });
    const failedState = await handle.tickNow();
    expect(failedState.lastError).toBe('disk full');

    const recoveredState = await handle.tickNow();
    expect(recoveredState.lastError).toBeUndefined();
    expect(recoveredState.lastResults).toEqual([SAMPLE_RESULT_NOOP]);
  });

  it('explicit intervalMs override bypasses env check', () => {
    const rotateFn = vi.fn(async () => [SAMPLE_RESULT_NOOP]);
    const handle = startChainRotationLoop({
      rawEnv: {} as NodeJS.ProcessEnv,
      intervalMs: MIN_INTERVAL_MS,
      rotateFn,
    });
    vi.advanceTimersByTime(MIN_INTERVAL_MS);
    expect(rotateFn).toHaveBeenCalledTimes(1);
    handle.stop();
  });
});
