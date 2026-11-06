import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

const embedReset = vi.fn(() => ({ cleared: true }));
const embedClearInMemory = vi.fn(() => ({ cleared: true }));
const embedDiscardReplacement = vi.fn(() => ({ discarded: true }));
const embedStore = vi.fn(() => ({ id: 'mock', count: 1, dim: 32, provider: 'mock' }));
const embedStoreMany = vi.fn((items: Array<{ id: string; text: string; tags?: string[] }>) => ({
  inserted: items.length,
  count: items.length,
  dim: 32,
  provider: 'mock',
  persistence_enabled: true,
}));
const embedFlush = vi.fn(() => ({ flushed: true, dim: 32 }));
const isEmbedRebuildSafe = vi.fn(() => true);
const getRustEmbedAdapterStatus = vi.fn(() => ({
  rustEnabled: true,
  rustBridgePath: 'mock-bridge',
  bridgeLoaded: true,
  embedApiAvailable: true,
  tunedSearchAvailable: false,
}));

vi.mock('../../src/infra/storage/rust-embed-adapter.js', () => ({
  embedReset,
  embedClearInMemory,
  embedDiscardReplacement,
  embedStore,
  embedStoreMany,
  embedFlush,
  isEmbedRebuildSafe,
  getRustEmbedAdapterStatus,
}));

function writeChainBlock(
  runtimeDir: string,
  chain: string,
  index: number,
  data: Record<string, unknown>,
): void {
  const hash = index.toString(16).padStart(64, '0');
  const prevHash = index === 1 ? '0'.repeat(64) : (index - 1).toString(16).padStart(64, '0');
  const chainDir = join(runtimeDir, 'chains', chain);
  mkdirSync(chainDir, { recursive: true });
  writeFileSync(
    join(chainDir, `${String(index).padStart(6, '0')}.json`),
    JSON.stringify(
      {
        index,
        timestamp: new Date(Date.UTC(2026, 2, 28, 12, 0, index)).toISOString(),
        chain,
        data,
        prev_hash: prevHash,
        hash,
      },
      null,
      2,
    ),
    'utf8',
  );
}

describe('runtime repair embeddings', () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    vi.clearAllMocks();
    vi.resetModules();
    for (const dir of tempDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('rebuilds derived embeddings from canonical chain truth with chain-scoped ids and tags', async () => {
    const runtimeDir = mkdtempSync(join(tmpdir(), 'memphis-runtime-embeddings-'));
    tempDirs.push(runtimeDir);
    const env = {
      ...process.env,
      NODE_ENV: 'test',
      MEMPHIS_DATA_DIR: runtimeDir,
      DATABASE_URL: `file:${join(runtimeDir, 'state', 'memphis.db')}`,
      RUST_CHAIN_ENABLED: 'true',
      LOCAL_FALLBACK_ENABLED: 'true',
    };

    writeChainBlock(runtimeDir, 'journal', 1, {
      type: 'journal',
      content: 'journal content',
      memory_id: 'same-custom-id',
      tags: ['repair', 'journal'],
    });
    writeChainBlock(runtimeDir, 'decisions', 1, {
      type: 'decision',
      content: 'decision content',
      memory_id: 'same-custom-id',
      tags: ['repair', 'decision'],
    });

    const { repairRuntimeState } = await import('../../src/infra/runtime/runtime-repair.js');
    const result = await repairRuntimeState({ rawEnv: env });

    expect(result.ok).toBe(true);
    // ADR-006: rebuild path uses the in-memory-only clear so a crash
    // between clear and flush leaves the previous on-disk index intact.
    // The destructive `embedReset` (which commits an empty payload to
    // disk first) MUST NOT be called by the rebuilder — regression
    // guard for issue #628.
    expect(embedClearInMemory).toHaveBeenCalledTimes(1);
    expect(embedReset).not.toHaveBeenCalled();
    // Custom IDs can collide across chains; source coordinates remain unique.
    expect(embedStoreMany).toHaveBeenCalledTimes(1);
    expect(embedStoreMany).toHaveBeenCalledWith(
      expect.arrayContaining([
        expect.objectContaining({
          id: 'journal-1',
          text: 'journal content',
          tags: expect.arrayContaining(['repair', 'journal', 'chain:journal']),
        }),
        expect.objectContaining({
          id: 'decisions-1',
          text: 'decision content',
          tags: expect.arrayContaining(['repair', 'decision', 'chain:decisions']),
        }),
      ]),
      env,
    );
    expect(embedFlush).toHaveBeenCalledTimes(1);
    expect(embedStore).not.toHaveBeenCalled();
    expect(
      result.applied.some((item) =>
        item.includes('rebuilt derived embeddings (2 indexed, 0 skipped'),
      ),
    ).toBe(true);
  });

  it('refuses an unsafe rebuild when the bridge lacks bulk support', async () => {
    isEmbedRebuildSafe.mockReturnValueOnce(false);
    const runtimeDir = mkdtempSync(join(tmpdir(), 'memphis-runtime-embeddings-legacy-'));
    tempDirs.push(runtimeDir);
    const env = {
      ...process.env,
      NODE_ENV: 'test',
      MEMPHIS_DATA_DIR: runtimeDir,
      DATABASE_URL: `file:${join(runtimeDir, 'state', 'memphis.db')}`,
      RUST_CHAIN_ENABLED: 'true',
      LOCAL_FALLBACK_ENABLED: 'true',
    };

    writeChainBlock(runtimeDir, 'journal', 1, {
      type: 'journal',
      content: 'legacy fallback content',
      tags: ['legacy'],
    });

    const { repairRuntimeState } = await import('../../src/infra/runtime/runtime-repair.js');
    const result = await repairRuntimeState({ rawEnv: env });

    expect(result.ok).toBe(true);
    expect(result.skipped.some((item) => item.includes('safe bulk and abort support'))).toBe(true);
    expect(embedClearInMemory).not.toHaveBeenCalled();
    expect(embedStoreMany).not.toHaveBeenCalled();
    expect(embedFlush).not.toHaveBeenCalled();
    expect(embedStore).not.toHaveBeenCalled();
  });

  it('does not flush a partial index after an embedding failure', async () => {
    const runtimeDir = mkdtempSync(join(tmpdir(), 'memphis-reindex-failure-'));
    tempDirs.push(runtimeDir);
    const env = { ...process.env, NODE_ENV: 'test', MEMPHIS_DATA_DIR: runtimeDir };
    writeChainBlock(runtimeDir, 'journal', 1, { type: 'journal', content: 'fixture' });
    embedStoreMany.mockImplementationOnce(() => {
      throw new Error('fixture provider failed');
    });
    const { rebuildDerivedEmbeddings } = await import('../../src/infra/memory/embed-reindex.js');

    expect(() => rebuildDerivedEmbeddings({}, env)).toThrow('fixture provider failed');
    expect(embedFlush).not.toHaveBeenCalled();
    expect(embedStore).not.toHaveBeenCalled();
    expect(embedDiscardReplacement).toHaveBeenCalledTimes(1);
  });

  it('reports a flush failure rather than claiming a successful rebuild', async () => {
    const runtimeDir = mkdtempSync(join(tmpdir(), 'memphis-reindex-flush-'));
    tempDirs.push(runtimeDir);
    const env = { ...process.env, NODE_ENV: 'test', MEMPHIS_DATA_DIR: runtimeDir };
    writeChainBlock(runtimeDir, 'journal', 1, { type: 'journal', content: 'fixture' });
    embedFlush.mockImplementationOnce(() => {
      throw new Error('fixture flush failed');
    });
    const { rebuildDerivedEmbeddings } = await import('../../src/infra/memory/embed-reindex.js');

    expect(() => rebuildDerivedEmbeddings({}, env)).toThrow('fixture flush failed');
    expect(embedDiscardReplacement).toHaveBeenCalledTimes(1);
  });

  it('does not clear other chains when rebuilding a single chain', async () => {
    const runtimeDir = mkdtempSync(join(tmpdir(), 'memphis-reindex-chain-'));
    tempDirs.push(runtimeDir);
    const env = { ...process.env, NODE_ENV: 'test', MEMPHIS_DATA_DIR: runtimeDir };
    writeChainBlock(runtimeDir, 'journal', 1, { type: 'journal', content: 'fixture' });
    const { rebuildDerivedEmbeddings } = await import('../../src/infra/memory/embed-reindex.js');

    expect(rebuildDerivedEmbeddings({ chain: 'journal' }, env).cleared).toBe(false);
    expect(embedClearInMemory).not.toHaveBeenCalled();
    expect(() => rebuildDerivedEmbeddings({ chain: 'journal', reset: true }, env)).toThrow(
      /refusing to replace/,
    );
  });
});
