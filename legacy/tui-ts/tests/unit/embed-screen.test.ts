import { describe, expect, it, vi } from 'vitest';

const { storeDurableMemoryMock } = vi.hoisted(() => ({
  storeDurableMemoryMock: vi.fn(),
}));

vi.mock('../../src/infra/memory/durable-memory.js', () => ({
  storeDurableMemory: storeDurableMemoryMock,
}));

import { embedStoreScreen } from '../../src/tui/screens/embed-screen.js';

describe('embed screen', () => {
  it('stores operator memory through the durable memory path', async () => {
    storeDurableMemoryMock.mockResolvedValue({
      success: true,
      memoryId: 'marcin',
      index: 3,
      hash: 'abc',
      indexed: true,
      embed: { id: 'marcin', count: 1, dim: 32, provider: 'local-deterministic' },
    });

    const out = await embedStoreScreen('marcin', 'Marcin jest twórcą Memphis');

    expect(storeDurableMemoryMock).toHaveBeenCalledWith({
      memoryId: 'marcin',
      content: 'Marcin jest twórcą Memphis',
      source: 'tui-embed',
      tags: ['operator-memory'],
    });
    expect(out).toContain('memory stored: id=marcin');
    expect(out).toContain('journal_index=3');
    expect(out).toContain('provider=local-deterministic');
  });
});
