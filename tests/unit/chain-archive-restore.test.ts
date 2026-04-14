import { createWriteStream, mkdtempSync, rmSync } from 'node:fs';
import * as fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { createGzip } from 'node:zlib';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { hashBlock, type ChainBlock } from '../../src/infra/storage/chain-adapter.js';
import {
  ChainArchiveRestoreError,
  restoreChainFromArchive,
} from '../../src/infra/storage/chain-archive-restore.js';

async function makeBlock(
  index: number,
  prev_hash: string,
  content: string,
  chainName = 'testchain',
): Promise<ChainBlock> {
  const withoutHash = {
    index,
    timestamp: `2026-04-14T12:00:0${index % 10}.000Z`,
    chain: chainName,
    data: { content } as Record<string, unknown>,
    prev_hash,
  };
  const crypto = await import('node:crypto');
  return { ...withoutHash, hash: hashBlock(withoutHash, crypto) };
}

async function writeGzippedArchive(
  archivePath: string,
  blocks: ChainBlock[],
): Promise<void> {
  const gzip = createGzip({ level: 1 });
  const out = createWriteStream(archivePath);
  const done = pipeline(gzip, out);
  for (const block of blocks) {
    gzip.write(`${JSON.stringify(block)}\n`);
  }
  gzip.end();
  await done;
}

describe('restoreChainFromArchive (closes deferred item #6)', () => {
  let dataDir: string;
  const savedEnv = { ...process.env };

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), 'memphis-archive-restore-'));
    process.env.MEMPHIS_DATA_DIR = dataDir;
    process.env.RUST_CHAIN_ENABLED = 'false';
  });

  afterEach(() => {
    rmSync(dataDir, { recursive: true, force: true });
    for (const key of Object.keys(process.env)) {
      if (!(key in savedEnv)) delete process.env[key];
    }
    Object.assign(process.env, savedEnv);
  });

  it('refuses invalid chain names', async () => {
    await expect(
      restoreChainFromArchive('../sneaky', '/tmp/nope.jsonl.gz'),
    ).rejects.toThrow(ChainArchiveRestoreError);
  });

  it('refuses a missing archive file', async () => {
    await expect(
      restoreChainFromArchive('testchain', join(dataDir, 'does-not-exist.jsonl.gz')),
    ).rejects.toMatchObject({ code: 'archive-not-found' });
  });

  it('happy path: restores a valid 3-block archive into an empty chain', async () => {
    const b1 = await makeBlock(1, '', 'alpha');
    const b2 = await makeBlock(2, b1.hash, 'beta');
    const b3 = await makeBlock(3, b2.hash, 'gamma');
    const archivePath = join(dataDir, 'archive.jsonl.gz');
    await writeGzippedArchive(archivePath, [b1, b2, b3]);

    const result = await restoreChainFromArchive('testchain', archivePath);
    expect(result.blocksRead).toBe(3);
    expect(result.blocksRestored).toBe(3);
    expect(result.firstIndex).toBe(1);
    expect(result.lastIndex).toBe(3);

    // Verify files are on disk
    const chainDir = join(dataDir, 'chains', 'testchain');
    const files = await fs.readdir(chainDir);
    expect(files.sort()).toEqual(['000001.json', '000002.json', '000003.json']);
  });

  it('rejects an archive with a tampered block hash', async () => {
    const b1 = await makeBlock(1, '', 'alpha');
    const tampered = { ...b1, hash: 'deadbeef'.padEnd(64, '0') };
    const archivePath = join(dataDir, 'bad.jsonl.gz');
    await writeGzippedArchive(archivePath, [tampered]);

    await expect(
      restoreChainFromArchive('testchain', archivePath),
    ).rejects.toMatchObject({ code: 'hash-mismatch' });
  });

  it('rejects an archive with internal prev_hash break', async () => {
    const b1 = await makeBlock(1, '', 'alpha');
    const b2 = await makeBlock(2, 'wrong-prev-hash', 'beta');
    const archivePath = join(dataDir, 'break.jsonl.gz');
    await writeGzippedArchive(archivePath, [b1, b2]);

    await expect(
      restoreChainFromArchive('testchain', archivePath),
    ).rejects.toMatchObject({ code: 'internal-chain-break' });
  });

  it('rejects an archive that does not continue the active chain tail', async () => {
    // Existing chain tail hash = X. Archive first block's prev_hash = Y. Mismatch.
    const existing = await makeBlock(1, '', 'existing');
    const chainDir = join(dataDir, 'chains', 'testchain');
    await fs.mkdir(chainDir, { recursive: true });
    await fs.writeFile(
      join(chainDir, '000001.json'),
      JSON.stringify(existing),
      'utf8',
    );

    const b2 = await makeBlock(2, 'not-the-right-prev-hash', 'mismatch');
    const archivePath = join(dataDir, 'disc.jsonl.gz');
    await writeGzippedArchive(archivePath, [b2]);

    await expect(
      restoreChainFromArchive('testchain', archivePath),
    ).rejects.toMatchObject({ code: 'discontinuous-with-active' });
  });

  it('allowDiscontinuousRestore bypasses the continuity check', async () => {
    const existing = await makeBlock(1, '', 'existing');
    const chainDir = join(dataDir, 'chains', 'testchain');
    await fs.mkdir(chainDir, { recursive: true });
    await fs.writeFile(
      join(chainDir, '000001.json'),
      JSON.stringify(existing),
      'utf8',
    );

    const b2 = await makeBlock(2, 'not-the-right-prev-hash', 'mismatch');
    const archivePath = join(dataDir, 'disc.jsonl.gz');
    await writeGzippedArchive(archivePath, [b2]);

    const result = await restoreChainFromArchive('testchain', archivePath, {
      allowDiscontinuousRestore: true,
    });
    expect(result.blocksRestored).toBe(1);
  });

  it('skipExisting=true (default) does not overwrite existing blocks', async () => {
    const b1 = await makeBlock(1, '', 'original');
    const chainDir = join(dataDir, 'chains', 'testchain');
    await fs.mkdir(chainDir, { recursive: true });
    await fs.writeFile(
      join(chainDir, '000001.json'),
      JSON.stringify(b1),
      'utf8',
    );

    // Archive with a DIFFERENT block at index 1
    const b1prime = await makeBlock(1, '', 'different');
    const archivePath = join(dataDir, 'overlap.jsonl.gz');
    await writeGzippedArchive(archivePath, [b1prime]);

    const result = await restoreChainFromArchive('testchain', archivePath, {
      allowDiscontinuousRestore: true,
    });
    expect(result.skippedExisting).toBe(1);
    expect(result.blocksRestored).toBe(0);

    // On-disk content must still be the original
    const stored = JSON.parse(
      await fs.readFile(join(chainDir, '000001.json'), 'utf8'),
    );
    expect(stored.hash).toBe(b1.hash);
  });

  it('rejects an empty archive', async () => {
    const archivePath = join(dataDir, 'empty.jsonl.gz');
    await writeGzippedArchive(archivePath, []);

    await expect(
      restoreChainFromArchive('testchain', archivePath),
    ).rejects.toMatchObject({ code: 'empty-archive' });
  });
});
