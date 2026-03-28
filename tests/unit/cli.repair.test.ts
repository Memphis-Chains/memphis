import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { runCli } from '../helpers/cli.js';

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

describe('CLI repair', () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('runs repair runtime and returns JSON status', async () => {
    const runtimeDir = mkdtempSync(join(tmpdir(), 'memphis-cli-repair-'));
    tempDirs.push(runtimeDir);
    const env = {
      NODE_ENV: 'test',
      MEMPHIS_DATA_DIR: runtimeDir,
      DATABASE_URL: `file:${join(runtimeDir, 'nested', 'memphis.db')}`,
      RUST_CHAIN_ENABLED: 'false',
      LOCAL_FALLBACK_ENABLED: 'true',
    };

    writeChainBlock(runtimeDir, 'journal', 1, {
      type: 'journal',
      content: 'repair runtime command should create sqlite and rebuild exact search',
      tags: ['repair', 'cli'],
    });

    const out = await runCli(['repair', 'runtime', '--json'], { env });
    const payload = JSON.parse(out) as {
      ok: boolean;
      status: string;
      applied: string[];
      after: { exactSearch: { status: string } };
    };

    expect(payload.ok).toBe(true);
    expect(payload.status).toBe('healthy');
    expect(payload.after.exactSearch.status).toBe('indexed');
    expect(payload.applied.some((item) => item.includes('rebuilt exact-search index'))).toBe(true);
  });
});
