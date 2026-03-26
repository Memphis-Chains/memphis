import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { stableStringify } from '../../src/core/stable-stringify.js';
import { runCli, runCliResult } from '../helpers/cli.js';

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
      tags: ['cli-test'],
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

describe('CLI chain export', () => {
  it('prints the full export envelope to stdout by default', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'memphis-cli-chain-export-'));
    const chainDir = join(dataDir, 'chains', 'journal');
    mkdirSync(chainDir, { recursive: true });

    const firstHash = writeChainBlock(chainDir, {
      index: 1,
      chain: 'journal',
      content: 'first exported block',
      prevHash: '0'.repeat(64),
    });
    writeChainBlock(chainDir, {
      index: 2,
      chain: 'journal',
      content: 'second exported block',
      prevHash: firstHash,
    });

    const out = await runCli(['chain', 'export', '--chain', 'journal'], {
      env: { MEMPHIS_DATA_DIR: dataDir },
    });
    const exported = JSON.parse(out);

    expect(exported.chainName).toBe('journal');
    expect(exported.blockCount).toBe(2);
    expect(exported.blocks[1].data.content).toBe('second exported block');
  });

  it('writes the export envelope to a file and returns metadata in json mode', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'memphis-cli-chain-export-out-'));
    const chainDir = join(dataDir, 'chains', 'journal');
    const outPath = join(dataDir, 'journal-export.json');
    mkdirSync(chainDir, { recursive: true });

    writeChainBlock(chainDir, {
      index: 1,
      chain: 'journal',
      content: 'persist me',
      prevHash: '0'.repeat(64),
    });

    const out = await runCli(
      ['chain', 'export', '--chain', 'journal', '--out', outPath, '--json'],
      { env: { MEMPHIS_DATA_DIR: dataDir } },
    );
    const summary = JSON.parse(out);

    expect(summary.ok).toBe(true);
    expect(summary.chain).toBe('journal');
    expect(summary.blockCount).toBe(1);
    expect(summary.out).toBe(outPath);

    const persisted = JSON.parse(readFileSync(outPath, 'utf8'));
    expect(persisted.chainName).toBe('journal');
    expect(persisted.blocks).toHaveLength(1);
  });

  it('fails cleanly when --chain is missing', async () => {
    const result = await runCliResult(['chain', 'export']);
    expect(result.status).not.toBe(0);
    expect(result.stderr || result.stdout).toContain('Missing required --chain for chain export');
  });
});
