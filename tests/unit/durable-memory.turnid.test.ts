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

  it("defaults consent to 'exportable' when caller omits consent AND surface (grandfathering)", async () => {
    const append = mockAppend();
    const index = mockIndex();

    await storeDurableMemory(
      {
        content: 'legacy caller frame',
        source: 'chat',
        // neither turnId, consent, nor surface passed
      },
      { append: append as never, index: index as never },
    );

    const [, dataArg] = append.mock.calls[0];
    // Pre-N8 grandfathering per trajectory-v1 spec — consent-less
    // legacy blocks read as exportable, so write-side fallback matches.
    expect(dataArg).toHaveProperty('consent', 'exportable');
    expect(dataArg).not.toHaveProperty('turn_id');
  });

  it('resolves consent from surface hint (chat class → local-only)', async () => {
    const append = mockAppend();
    const index = mockIndex();

    await storeDurableMemory(
      {
        content: 'telegram journal entry',
        source: 'telegram',
        surface: 'telegram',
      },
      { append: append as never, index: index as never },
    );

    const [, dataArg] = append.mock.calls[0];
    expect(dataArg).toHaveProperty('consent', 'local-only');
  });

  it('explicit consent outranks surface hint', async () => {
    const append = mockAppend();
    const index = mockIndex();

    await storeDurableMemory(
      {
        content: 'operator override',
        surface: 'telegram',
        consent: 'exportable',
      },
      { append: append as never, index: index as never },
    );

    const [, dataArg] = append.mock.calls[0];
    expect(dataArg).toHaveProperty('consent', 'exportable');
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
    // Grandfathered fallback: legacy callers get exportable (matches
    // trajectory-v1 reader assumption for consent-less old blocks).
    expect(dataArg).toMatchObject({ consent: 'exportable' });
    expect(dataArg).not.toHaveProperty('turn_id');
  });
});
