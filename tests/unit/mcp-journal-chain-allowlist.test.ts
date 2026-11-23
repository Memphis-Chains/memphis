import { describe, expect, it, vi } from 'vitest';

import { runMemphisJournal, type JournalDeps } from '../../src/mcp/tools/journal.js';

/**
 * The chain allowlist at the TOOL boundary.
 *
 * `memphis_journal` accepts a `chain` argument (issue #645: the operator
 * had no way to append to the soul chain). The name it is given must be
 * one a tool may write to on the operator's request — `system` and
 * `security` are written by the runtime's own audit path, which refuses
 * writes from processes that have not opted in.
 *
 * The check belongs at this boundary and not inside `storeDurableMemory`:
 * that function is the runtime's own durable-memory path, and the
 * runtime writes to `decisions` and `system` through it. A check placed
 * there refuses the runtime's own writes — which is exactly what the
 * test suite caught when the check was in the wrong place.
 */

function deps(): JournalDeps & { store: ReturnType<typeof vi.fn> } {
  return {
    store: vi.fn(async () => ({
      success: true,
      memoryId: 'memory-1',
      index: 1,
      hash: 'hash-1',
      indexed: true,
    })),
  };
}

describe('memphis_journal — the named-chain allowlist', () => {
  it('writes to the journal when no chain is named', async () => {
    const store = deps();
    const result = await runMemphisJournal({ content: 'hello' }, store);

    expect(result.success).toBe(true);
    expect(store.store).toHaveBeenCalledOnce();
    expect(store.store.mock.calls[0][0]).toMatchObject({ chain: undefined });
  });

  it.each(['journal', 'soul', 'reflections', 'cases', 'patterns'])(
    'allows the %s chain',
    async (chain) => {
      const store = deps();
      const result = await runMemphisJournal({ content: 'hello', chain }, store);

      expect(result.success).toBe(true);
      expect(store.store).toHaveBeenCalledOnce();
      expect(store.store.mock.calls[0][0]).toMatchObject({ chain });
    },
  );

  it.each(['system', 'security', 'decisions', 'not-a-chain'])(
    'refuses the %s chain without writing anything',
    async (chain) => {
      const store = deps();
      const result = await runMemphisJournal({ content: 'hello', chain }, store);

      expect(result.success).toBe(false);
      expect(result.error).toContain(chain);
      expect(store.store).not.toHaveBeenCalled();
    },
  );

  it('refuses an empty chain name rather than defaulting to the journal', async () => {
    // An empty string is a name the operator gave. Treating it as "no
    // name" would silently write somewhere the operator did not ask for.
    const store = deps();
    const result = await runMemphisJournal({ content: 'hello', chain: '   ' }, store);

    expect(result.success).toBe(false);
    expect(store.store).not.toHaveBeenCalled();
  });
});
