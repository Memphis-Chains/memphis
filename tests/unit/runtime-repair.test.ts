import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { searchExactMemory } from '../../src/infra/memory/exact-search.js';
import { repairRuntimeState } from '../../src/infra/runtime/runtime-repair.js';

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

describe('runtime repair', () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('rebuilds exact-search from canonical chain truth', async () => {
    const runtimeDir = mkdtempSync(join(tmpdir(), 'memphis-runtime-repair-'));
    tempDirs.push(runtimeDir);
    const env = {
      ...process.env,
      NODE_ENV: 'test',
      MEMPHIS_DATA_DIR: runtimeDir,
      DATABASE_URL: `file:${join(runtimeDir, 'state', 'memphis.db')}`,
      RUST_CHAIN_ENABLED: 'false',
      LOCAL_FALLBACK_ENABLED: 'true',
    };

    writeChainBlock(runtimeDir, 'journal', 1, {
      type: 'journal',
      content: 'Repair should rebuild the exact search index from chain truth',
      tags: ['repair', 'search'],
    });

    const result = await repairRuntimeState({ rawEnv: env });

    expect(result.ok).toBe(true);
    expect(result.after.exactSearch.status).toBe('indexed');
    expect(result.after.repair.status).toBe('healthy');
    expect(result.applied.some((item) => item.includes('rebuilt exact-search index'))).toBe(true);

    const hit = searchExactMemory('rebuild the exact search index', 5, env);
    expect(hit.count).toBe(1);
    expect(hit.hits[0]?.chain).toBe('journal');
  });

  it('rebuilds degraded patterns lane from canonical decisions', async () => {
    const runtimeDir = mkdtempSync(join(tmpdir(), 'memphis-runtime-patterns-'));
    tempDirs.push(runtimeDir);
    const env = {
      ...process.env,
      NODE_ENV: 'test',
      MEMPHIS_DATA_DIR: runtimeDir,
      DATABASE_URL: `file:${join(runtimeDir, 'memphis.db')}`,
      RUST_CHAIN_ENABLED: 'false',
      LOCAL_FALLBACK_ENABLED: 'true',
    };

    for (const [index, content] of [
      'Stabilize API rollout for local runtime',
      'Stabilize API rollout for offline runtime',
      'Stabilize API rollout for operator runtime',
    ].entries()) {
      writeChainBlock(runtimeDir, 'decisions', index + 1, {
        type: 'decision',
        content,
        tags: ['api', 'stability'],
      });
    }

    const patternsDir = join(runtimeDir, 'chains', 'patterns');
    mkdirSync(patternsDir, { recursive: true });
    writeFileSync(join(patternsDir, '000001.json'), '{ bad json', 'utf8');
    writeFileSync(join(runtimeDir, 'patterns.json'), '{ bad json', 'utf8');

    const result = await repairRuntimeState({ rawEnv: env });

    expect(result.ok).toBe(true);
    expect(result.after.cognition.persistenceStatus).toBe('ready');
    expect(result.after.repair.status).toBe('healthy');
    expect(result.applied.some((item) => item.includes('rebuilt derived pattern state'))).toBe(
      true,
    );
    expect(existsSync(join(runtimeDir, 'patterns.json'))).toBe(false);
    expect(result.after.cognition.patternsChain.entries).toBeGreaterThan(0);
  });
});
