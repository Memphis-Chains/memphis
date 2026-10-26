import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { expect, it, vi } from 'vitest';

const append = vi.hoisted(() => vi.fn());
vi.mock('../../src/infra/storage/chain-adapter.js', () => ({ appendBlock: append }));
vi.mock('../../src/infra/storage/rust-chain-adapter.js', () => ({
  getRecentBlocks: vi.fn(async () => []),
}));

import { ChainStore } from '../../src/cognitive/store.js';
import { runReflectionCycle } from '../../src/infra/runtime/reflection-loop.js';
import { loadMemoryEntries } from '../../src/soul/memory.js';

it('waits for the soul write and keeps every write inside the supplied environment', async () => {
  const root = mkdtempSync(join(tmpdir(), 'memphis-reflection-boundary-'));
  const environment = { ...process.env, MEMPHIS_DATA_DIR: root, MEMPHIS_HOME: root };
  const original = { ...environment };
  let signalStarted!: () => void;
  let release!: () => void;
  const started = new Promise<void>((resolve) => {
    signalStarted = resolve;
  });
  const blocked = new Promise<void>((resolve) => {
    release = resolve;
  });
  append.mockImplementation(async (chain: string) => {
    if (chain === 'soul') {
      signalStarted();
      await blocked;
    }
    return { chain, index: 0, hash: 'a'.repeat(64), timestamp: new Date().toISOString() };
  });
  let settled = false;
  const running = runReflectionCycle({ rawEnv: environment, periods: ['daily'] }).then((value) => {
    settled = true;
    return value;
  });
  try {
    await Promise.race([
      started,
      running.then(() => {
        throw new Error('cycle returned without a soul write');
      }),
    ]);
    await Promise.resolve();
    expect(settled).toBe(false);
    environment.MEMPHIS_DATA_DIR = '/var/lib/memphis-unrelated';
    environment.MEMPHIS_HOME = '/var/lib/memphis-unrelated';
  } finally {
    release();
    await running;
  }
  expect(append.mock.calls.some(([chain]) => chain === 'soul')).toBe(true);
  for (const [, , rawEnv] of append.mock.calls)
    expect(rawEnv).toMatchObject({ MEMPHIS_DATA_DIR: root, MEMPHIS_HOME: root });
  expect(loadMemoryEntries(original)).toHaveLength(1);
});

it('does not expose a captured environment when a store is serialized', () => {
  const store = new ChainStore({
    MEMPHIS_DATA_DIR: '/temporary/source',
    MINIMAX_API_KEY: 'synthetic-store-key',
  });
  expect(JSON.stringify(store)).not.toContain('synthetic-store-key');
  const exposed = store.getEnvironment();
  exposed.MEMPHIS_DATA_DIR = '/unrelated';
  expect(store.getEnvironment().MEMPHIS_DATA_DIR).toBe('/temporary/source');
});
