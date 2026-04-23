import { describe, expect, it, vi } from 'vitest';

import { storeDurableMemory } from '../../src/infra/memory/durable-memory.js';

/**
 * N8 — turnId + consent propagation tests.
 *
 * Verifies that the Y1 trajectory-export v1 plumbing reaches the
 * block.data payload end-to-end through `storeDurableMemory`:
 *   - explicit `turnId` + `consent` propagate into the appendBlock call
 *   - omitting `turnId` leaves the field unset (not emitted as `undefined`)
 *   - omitting `consent` defaults to 'local-only' (privacy-first)
 *   - existing callers (no turnId/consent) remain backward compatible
 */

type AppendResult = {
  index: number;
  hash: string;
  chain: string;
  timestamp: string;
};

function mockAppend(result: Partial<AppendResult> = {}): ReturnType<typeof vi.fn> {
  return vi.fn(async () => ({
    index: 1,
    hash: 'h1',
    chain: 'journal',
    timestamp: '2026-04-23T00:00:00.000Z',
    ...result,
  }));
}

function mockIndex(): ReturnType<typeof vi.fn> {
  return vi.fn(() => ({ id: 'x', count: 1, dim: 32, provider: 'local-deterministic' }));
}

describe('durable memory — turnId + consent propagation (N8)', () => {
  it('stamps turnId + consent on the appended block', async () => {
    const append = mockAppend();
    const index = mockIndex();

    await storeDurableMemory(
      {
        content: 'operator confirmed deploy plan',
        tags: ['decisions'],
        source: 'cli',
        chain: 'decisions',
        turnId: 'turn_abc123',
        consent: 'exportable',
      },
      { append: append as never, index: index as never },
    );

    expect(append).toHaveBeenCalledTimes(1);
    const [chainArg, dataArg] = append.mock.calls[0];
    expect(chainArg).toBe('decisions');
    expect(dataArg).toMatchObject({
      content: 'operator confirmed deploy plan',
      consent: 'exportable',
      turn_id: 'turn_abc123',
    });
  });

  it('omits turn_id when turnId not provided (unlinked events)', async () => {
    const append = mockAppend();
    const index = mockIndex();

    await storeDurableMemory(
      {
        content: 'scheduler tick',
        tags: ['scheduler'],
        source: 'cron',
        chain: 'system',
        consent: 'exportable',
        // no turnId — scheduled write
      },
      { append: append as never, index: index as never },
    );

    const [, dataArg] = append.mock.calls[0];
    expect(dataArg).toHaveProperty('consent', 'exportable');
    expect(dataArg).not.toHaveProperty('turn_id');
  });

  it("defaults consent to 'local-only' when caller omits it (privacy-first)", async () => {
    const append = mockAppend();
    const index = mockIndex();

    await storeDurableMemory(
      {
        content: 'conversation frame',
        source: 'chat',
        // neither turnId nor consent passed
      },
      { append: append as never, index: index as never },
    );

    const [, dataArg] = append.mock.calls[0];
    expect(dataArg).toHaveProperty('consent', 'local-only');
    expect(dataArg).not.toHaveProperty('turn_id');
  });

  it('accepts anonymized consent level', async () => {
    const append = mockAppend();
    const index = mockIndex();

    await storeDurableMemory(
      {
        content: 'sensitive observation',
        chain: 'journal',
        turnId: 'turn_xyz',
        consent: 'anonymized',
      },
      { append: append as never, index: index as never },
    );

    const [, dataArg] = append.mock.calls[0];
    expect(dataArg).toMatchObject({ consent: 'anonymized', turn_id: 'turn_xyz' });
  });

  it('preserves backward compat — existing callers without turnId/consent still work', async () => {
    const append = mockAppend();
    const index = mockIndex();

    const result = await storeDurableMemory(
      {
        memoryId: 'legacy-1',
        content: 'pre-N8 caller',
        tags: ['legacy'],
      },
      { append: append as never, index: index as never },
    );

    expect(result.success).toBe(true);
    const [, dataArg] = append.mock.calls[0];
    // consent default lands on the block; turn_id does not leak
    expect(dataArg).toMatchObject({ consent: 'local-only' });
    expect(dataArg).not.toHaveProperty('turn_id');
  });
});
