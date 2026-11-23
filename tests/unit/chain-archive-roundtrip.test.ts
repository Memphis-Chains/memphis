/**
 * An archive the writer produces must be readable by the reader.
 *
 * ## The failure this exists for
 *
 * The rotation writer copied the RAW BYTES of each block file into the
 * archive. Block files are written pretty-printed —
 * `JSON.stringify(block, null, 2)` in `chain-adapter.ts` — so the
 * archive was a stream of multi-line JSON objects glued together by
 * newlines.
 *
 * The reader split the archive on newlines and ran `JSON.parse` on each
 * line, which is what "JSON Lines" means: one JSON value per line.
 *
 * Measured 2026-11-23 on this host, on a real rotation of the `insights`
 * chain (404 blocks, 31.92 MB, 297 blocks archived):
 *
 *     $ memphis chain restore --chain insights --file <archive>
 *     [INTERNAL_ERROR] parse error in archive: Expected property name
 *     or '}' in JSON at position 1 (line 1 column 2)
 *
 * The archive held 172 151 lines for 297 blocks and its first line was
 * `{` — not a JSON value. Every archive the runtime produced was
 * unreadable, so the archived history was a write-only dead end.
 *
 * ## Why the old gate missed it
 *
 * `tests/unit/chain-archive-restore.test.ts` builds its fixtures with
 * `JSON.stringify(block)` — COMPACT, one block per line — which is a
 * format the production writer never produced. The gate was testing
 * the reader against a fixture from a writer that does not exist.
 *
 * A gate is only as good as its corpus. This file uses the REAL writer
 * (`rotateChain`) and the REAL reader (`restoreChainFromArchive`), so
 * the two can no longer disagree without the gate noticing.
 *
 * ## What each test pins
 *
 *   - "the writer emits true JSON Lines" — pins the WRITER side.
 *   - "the round trip survives" — pins both sides together.
 *   - "the legacy format still restores" — pins the READER side, and
 *     keeps the archive already on this host recoverable.
 */
import { createHash } from 'node:crypto';
import { createWriteStream, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import * as fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { createGzip } from 'node:zlib';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  hashBlock,
  verifyChainIntegrity,
  type ChainBlock,
} from '../../src/infra/storage/chain-adapter.js';
import { restoreChainFromArchive } from '../../src/infra/storage/chain-archive-restore.js';
import { serializeBlockForDisk } from '../../src/infra/storage/chain-file-io.js';
import { rotateChain } from '../../src/infra/storage/chain-rotation.js';

const CHAIN = 'archive-roundtrip-fixture';
/** Blocks of 200 KB — eight of them are 1.6 MB, over the 1 MiB threshold. */
const BLOCK_COUNT = 8;
const BLOCK_CONTENT_BYTES = 200_000;
/** The keep-count for the fixture rotation. */
const KEEP = 3;

const GENESIS_PREV_HASH = '0'.repeat(64);

describe('the archive format survives the round trip', () => {
  let sourceDir: string;
  let targetDir: string;

  beforeEach(() => {
    sourceDir = mkdtempSync(join(tmpdir(), 'memphis-archive-source-'));
    targetDir = mkdtempSync(join(tmpdir(), 'memphis-archive-target-'));
  });

  afterEach(() => {
    rmSync(sourceDir, { recursive: true, force: true });
    rmSync(targetDir, { recursive: true, force: true });
  });

  it('the writer emits true JSON Lines — one block per line', async () => {
    // The WRITER side of the contract.
    //
    // The file is named `.jsonl.gz`, so it must be JSON Lines: one JSON
    // value per line. The old writer pasted the pretty-printed block
    // files in, which made 297 blocks span 172 151 lines.
    writeFixtureChain(join(sourceDir, 'chains', CHAIN), BLOCK_COUNT);

    const result = await rotateChain(CHAIN, {
      rawEnv: {
        ...process.env,
        MEMPHIS_DATA_DIR: sourceDir,
        MEMPHIS_CHAIN_ROTATION_THRESHOLD_BYTES: String(1024 * 1024),
        MEMPHIS_CHAIN_ROTATION_MIN_KEEP_BLOCKS: String(KEEP),
      },
    });

    expect(result.rotated).toBe(true);
    expect(result.archivedBlocks).toBe(BLOCK_COUNT - KEEP);

    const lines = (await gunzipToLines(result.archivePath!)).filter((line) => line.trim().length > 0);

    // One line per block. The old writer produced hundreds of lines per
    // block.
    expect(lines.length).toBe(result.archivedBlocks);

    // And every line IS a JSON value — the old writer's first line was
    // `{`.
    for (const line of lines) {
      const parsed = JSON.parse(line) as { index?: unknown };
      expect(typeof parsed.index).toBe('number');
    }
  });

  it('the round trip survives — what the writer wrote, the reader reads', async () => {
    // Both sides together, through the real writer and the real reader.
    //
    // This is the test the old gate was missing: the fixture used to be
    // hand-built, so it never exercised the writer at all.
    writeFixtureChain(join(sourceDir, 'chains', CHAIN), BLOCK_COUNT);

    // The originals, captured BEFORE the rotation — the rotation deletes
    // the archived blocks from the live chain.
    const originals = new Map<string, string>();
    for (let index = 1; index <= BLOCK_COUNT; index += 1) {
      const name = `${String(index).padStart(6, '0')}.json`;
      originals.set(name, await fs.readFile(join(sourceDir, 'chains', CHAIN, name), 'utf8'));
    }

    const result = await rotateChain(CHAIN, {
      rawEnv: {
        ...process.env,
        MEMPHIS_DATA_DIR: sourceDir,
        MEMPHIS_CHAIN_ROTATION_THRESHOLD_BYTES: String(1024 * 1024),
        MEMPHIS_CHAIN_ROTATION_MIN_KEEP_BLOCKS: String(KEEP),
      },
    });
    expect(result.rotated).toBe(true);

    const restore = await restoreChainFromArchive(CHAIN, result.archivePath!, {
      rawEnv: { ...process.env, MEMPHIS_DATA_DIR: targetDir },
    });

    expect(restore.blocksRead).toBe(result.archivedBlocks);
    expect(restore.blocksRestored).toBe(result.archivedBlocks);
    expect(restore.firstIndex).toBe(1);
    expect(restore.lastIndex).toBe(result.archivedBlocks);

    // The restored chain is a real chain — it verifies.
    const verified = await verifyChainIntegrity(CHAIN, {
      ...process.env,
      MEMPHIS_DATA_DIR: targetDir,
    });
    expect(verified.ok).toBe(true);
    expect(verified.blockCount).toBe(result.archivedBlocks);

    // And it is BYTE-IDENTICAL to the chain that was rotated: the restore
    // writes blocks with the same serializer the append path uses, so
    // `cmp` says the same thing about every one of them.
    for (let index = 1; index <= result.archivedBlocks; index += 1) {
      const name = `${String(index).padStart(6, '0')}.json`;
      const restored = await fs.readFile(join(targetDir, 'chains', CHAIN, name), 'utf8');
      expect(restored).toBe(originals.get(name));
    }
  });

  it('a multi-byte character on a chunk boundary survives the round trip', async () => {
    // The DECODER side of the contract.
    //
    // `chunk.toString('utf8')` decodes each chunk on its own, so a
    // multi-byte character that straddles a chunk boundary becomes
    // U+FFFD. The block is then silently wrong.
    //
    // Measured 2026-11-23 on this host, on a real rotation of the
    // `insights` chain: 20 of 297 lines came back corrupted, the first
    // at block 190, where the restore then failed with "hash mismatch at
    // block 190". Every corrupted character sat exactly two bytes before
    // a 16 KB chunk boundary — the two bytes of `ó` (0xC3 0xB3), split
    // in half.
    //
    // The fixture uses a THREE-byte character throughout. The chunk
    // boundaries fall on multiples of 16 384, and 16 384 is 1 modulo 3,
    // so the residues cycle and every third boundary would align — the
    // other two split a character. A 150 KB content crosses enough
    // boundaries to make that certain.
    const content = '—'.repeat(50_000);
    writeFixtureChain(join(sourceDir, 'chains', CHAIN), 3, content);

    const result = await rotateChain(CHAIN, {
      thresholdBytes: 100_000,
      minKeepBlocks: 1,
      rawEnv: { ...process.env, MEMPHIS_DATA_DIR: sourceDir },
    });
    expect(result.rotated).toBe(true);
    expect(result.archivedBlocks).toBe(2);

    const restore = await restoreChainFromArchive(CHAIN, result.archivePath!, {
      rawEnv: { ...process.env, MEMPHIS_DATA_DIR: targetDir },
    });
    expect(restore.blocksRestored).toBe(2);

    // The content came back CHARACTER BY CHARACTER, not as replacement
    // characters.
    for (const index of [1, 2]) {
      const file = join(targetDir, 'chains', CHAIN, `${String(index).padStart(6, '0')}.json`);
      const restored = JSON.parse(await fs.readFile(file, 'utf8')) as { data: { content: string } };
      expect(restored.data.content).toBe(content);
      expect(restored.data.content).not.toContain('\uFFFD');
    }
  });

  it('the legacy format still restores — the archive on this host stays recoverable', async () => {
    // The READER side of the contract.
    //
    // There is a real legacy archive on this host —
    // `system_000001-015271_2026-11-22T15-57-33-906Z.jsonl.gz`, 15 271
    // blocks — written by the old writer in the pretty-printed layout.
    // A reader that only understood the new format would strand it, so
    // the reader accepts both.
    const blocks = makeFixtureBlocks(4);
    const archivePath = join(sourceDir, 'legacy.jsonl.gz');
    await writeLegacyArchive(archivePath, blocks);

    const restore = await restoreChainFromArchive(CHAIN, archivePath, {
      rawEnv: { ...process.env, MEMPHIS_DATA_DIR: targetDir },
    });

    expect(restore.blocksRead).toBe(4);
    expect(restore.blocksRestored).toBe(4);
  });
});

/**
 * Write the chain the way the adapter writes it: pretty-printed, one
 * file per block, six-digit index.
 *
 * The bytes go through `serializeBlockForDisk` — the ONE owner of the
 * block file's form. This function used to write `JSON.stringify(block,
 * null, 2)` inline, which was a third copy of the format rule: it
 * matched the writer of the day, and it stopped matching the moment the
 * canonical form changed. A gate whose corpus is written by a copy of
 * the rule is a gate about the copy.
 */
function writeFixtureChain(chainDir: string, count: number, content?: string): void {
  mkdirSync(chainDir, { recursive: true });
  for (const block of makeFixtureBlocks(count, content)) {
    writeFileSync(
      join(chainDir, `${String(block.index).padStart(6, 0)}.json`),
      serializeBlockForDisk(block),
      'utf8',
    );
  }
}

function makeFixtureBlocks(count: number, content?: string): ChainBlock[] {
  const blocks: ChainBlock[] = [];
  let prevHash = GENESIS_PREV_HASH;
  for (let index = 1; index <= count; index += 1) {
    const withoutHash = {
      index,
      timestamp: new Date(Date.UTC(2026, 0, 1, 0, 0, index)).toISOString(),
      chain: CHAIN,
      data: {
        type: 'journal',
        content: content ?? 'x'.repeat(BLOCK_CONTENT_BYTES),
        tags: [],
      } as Record<string, unknown>,
      prev_hash: prevHash,
    };
    const hash = hashBlock(withoutHash, { createHash } as never);
    blocks.push({ ...withoutHash, hash });
    prevHash = hash;
  }
  return blocks;
}

/**
 * Write an archive the way the OLD writer wrote it: the raw bytes of
 * each pretty-printed block file, one after another.
 */
async function writeLegacyArchive(archivePath: string, blocks: ChainBlock[]): Promise<void> {
  const gzip = createGzip({ level: 1 });
  const out = createWriteStream(archivePath);
  const done = pipeline(gzip, out);
  for (const block of blocks) {
    // The legacy archive held the block file's own bytes. The block file
    // goes through the one serializer, so the archive does too — the
    // legacy part of the format is the GLUING (one pretty-printed object
    // after another), not a second copy of the block form.
    gzip.write(`${serializeBlockForDisk(block).trim()}\n`);
  }
  gzip.end();
  await done;
}

async function gunzipToLines(archivePath: string): Promise<string[]> {
  const { createGunzip } = await import('node:zlib');
  const { createReadStream } = await import('node:fs');
  const chunks: Buffer[] = [];
  await new Promise<void>((resolve, reject) => {
    const stream = createReadStream(archivePath).pipe(createGunzip());
    stream.on('data', (chunk: Buffer) => chunks.push(chunk));
    stream.on('end', resolve);
    stream.on('error', reject);
  });
  return Buffer.concat(chunks).toString('utf8').split('\n');
}
