import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { stableStringify } from '../../src/core/stable-stringify.js';
import { exportChain } from '../../src/infra/storage/chain-adapter.js';

function writeChainBlock(
  chainDir: string,
  {
    index,
    chain,
    content,
    prevHash,
  }: {
    index: number;
    chain: string;
    content: string;
    prevHash: string;
  },
): string {
  const timestamp = `2026-03-26T12:00:0${index}.000Z`;
  const blockWithoutHash = {
    index,
    timestamp,
    chain,
    data: {
      type: 'journal',
      content,
      tags: ['test'],
    },
    prev_hash: prevHash,
  };
  const hash = createHash('sha256').update(stableStringify(blockWithoutHash)).digest('hex');
  writeFileSync(
    join(chainDir, `${String(index).padStart(6, '0')}.json`),
    `${JSON.stringify({ ...blockWithoutHash, hash }, null, 2)}\n`,
    'utf8',
  );
  return hash;
}

describe('exportChain', () => {
  it('exports a validated single-chain JSON envelope', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'memphis-chain-export-'));
    const chainDir = join(dataDir, 'chains', 'journal');
    mkdirSync(chainDir, { recursive: true });

    const firstHash = writeChainBlock(chainDir, {
      index: 1,
      chain: 'journal',
      content: 'first memory',
      prevHash: '0'.repeat(64),
    });
    writeChainBlock(chainDir, {
      index: 2,
      chain: 'journal',
      content: 'second memory',
      prevHash: firstHash,
    });

    const exported = await exportChain('journal', { MEMPHIS_DATA_DIR: dataDir } as NodeJS.ProcessEnv);

    expect(exported.chainName).toBe('journal');
    expect(exported.blockCount).toBe(2);
    expect(exported.blocks[0]?.data.content).toBe('first memory');
    expect(exported.blocks[1]?.prev_hash).toBe(firstHash);
  });

  it('fails when the named chain does not exist', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'memphis-chain-export-missing-'));

    await expect(
      exportChain('missing', { MEMPHIS_DATA_DIR: dataDir } as NodeJS.ProcessEnv),
    ).rejects.toThrow('chain export failed: chain "missing" not found');
  });
});
