import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

const embedReset = vi.fn(() => ({ cleared: true }));
const embedStore = vi.fn(() => ({ id: 'mock', count: 1, dim: 32, provider: 'mock' }));
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
    expect(embedStore).toHaveBeenCalledWith(
      'journal-1',
      'journal content',
      env,
      expect.arrayContaining(['repair', 'journal', 'chain:journal']),
    );
    expect(embedStore).toHaveBeenCalledWith(
      'decisions-1',
      'decision content',
      env,
      expect.arrayContaining(['repair', 'decision', 'chain:decisions']),
    );
    expect(
      result.applied.some((item) =>
        item.includes('rebuilt derived embeddings (2 indexed, 0 skipped'),
      ),
    ).toBe(true);
  });
});
