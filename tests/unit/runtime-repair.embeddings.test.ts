import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

const embedReset = vi.fn(() => ({ cleared: true }));
const embedStore = vi.fn(() => ({ id: 'mock', count: 1, dim: 32, provider: 'mock' }));
const embedStoreMany = vi.fn((items: Array<{ id: string; text: string; tags?: string[] }>) => ({
  inserted: items.length,
  count: items.length,
  dim: 32,
  provider: 'mock',
  persistence_enabled: true,
}));
const embedFlush = vi.fn(() => ({ flushed: true, dim: 32 }));
const isEmbedBulkAvailable = vi.fn(() => true);
const getRustEmbedAdapterStatus = vi.fn(() => ({
  rustEnabled: true,
  rustBridgePath: 'mock-bridge',
  bridgeLoaded: true,
  embedApiAvailable: true,
  tunedSearchAvailable: false,
}));

vi.mock('../../src/infra/storage/rust-embed-adapter.js', () => ({
  embedReset,
  embedStore,
  embedStoreMany,
  embedFlush,
  isEmbedBulkAvailable,
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
      tags: ['repair', 'journal'],
    });
    writeChainBlock(runtimeDir, 'decisions', 1, {
      type: 'decision',
      content: 'decision content',
      tags: ['repair', 'decision'],
    });

    const { repairRuntimeState } = await import('../../src/infra/runtime/runtime-repair.js');
    const result = await repairRuntimeState({ rawEnv: env });

    expect(result.ok).toBe(true);
    expect(embedReset).toHaveBeenCalledTimes(1);
    // Bulk-first path: items batched into a single embedStoreMany call,
    // then a single embedFlush at the end of the rebuild. The per-item
    // embedStore is the legacy fallback only when bulk isn't available.
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

  it('falls back to per-item embedStore when bulk surface is missing (legacy NAPI binary)', async () => {
    isEmbedBulkAvailable.mockReturnValueOnce(false);
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
    // Legacy path: single-item embedStore called per block, no bulk call,
    // and no flush (single-item path uses the auto_persist=true default
    // on the Rust side).
    expect(embedStoreMany).not.toHaveBeenCalled();
    expect(embedFlush).not.toHaveBeenCalled();
    expect(embedStore).toHaveBeenCalledWith(
      'journal-1',
      'legacy fallback content',
      env,
      expect.arrayContaining(['legacy', 'chain:journal']),
    );
  });
});
