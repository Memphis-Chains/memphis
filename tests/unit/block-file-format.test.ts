/**
 * A block file on disk has ONE format.
 *
 * ## The failure this exists for
 *
 * Six places write block files, and one of them wrote them differently.
 *
 * The append path, the repair path, the archive restore path, the case
 * adapter, the native adapter and the migration runner all write block
 * files. Five wrote pretty-printed JSON (`JSON.stringify(block, null,
 * 2)`); the migration runner wrote COMPACT JSON — and it wrote it into
 * the LIVE chain directory, through the atomic swap that replaces the
 * chain.
 *
 * Nothing broke: the canonical hash covers a block's VALUES, not its
 * bytes, so a migrated chain verified exactly like every other chain.
 * But a migrated chain was the only one of its kind on the disk, and
 * nothing said why. The archive restore had the same shape — compact —
 * and the two together meant "a block file's format" had no single
 * answer.
 *
 * The format now has one owner: `serializeBlockForDisk` in
 * `src/infra/storage/chain-file-io.ts`. This gate pins it at the two
 * writers that are easiest to reach — the append path and the migration
 * runner — and the round trip in
 * `tests/unit/chain-archive-roundtrip.test.ts` pins the third.
 *
 * The property is a byte comparison, not a format guess: the file on
 * disk must equal `serializeBlockForDisk` of its own parsed content.
 * That is what makes it falsifiable — a writer that compactens the JSON
 * fails it.
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { appendBlock } from '../../src/infra/storage/chain-adapter.js';
import { serializeBlockForDisk } from '../../src/infra/storage/chain-file-io.js';
import { runChainMigrations } from '../../src/infra/storage/migrations/runner.js';

const CHAIN = 'block-format-fixture';

describe('a block file on disk has one format', () => {
  let root: string;
  let rawEnv: NodeJS.ProcessEnv;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'memphis-block-format-'));
    rawEnv = { ...process.env, MEMPHIS_DATA_DIR: root };
    mkdirSync(join(root, 'chains'), { recursive: true });
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('the append path writes the canonical format', async () => {
    await appendBlock(CHAIN, { type: 'journal', content: 'hello', tags: [] }, rawEnv);

    const file = join(root, 'chains', CHAIN, '000001.json');
    const written = readFileSync(file, 'utf8');

    // The byte comparison: the file is exactly what the one serializer
    // produces for its own content.
    expect(written).toBe(serializeBlockForDisk(JSON.parse(written)));

    // And it is the pretty-printed form — a compact writer would fail
    // here even though the block would still verify.
    expect(written).toContain('\n  "index"');
  });

  it('a migrated chain comes out in the canonical format', async () => {
    // Seed a chain in the canonical format, then migrate it.
    await appendBlock(CHAIN, { type: 'journal', content: 'one', tags: [] }, rawEnv);
    await appendBlock(CHAIN, { type: 'journal', content: 'two', tags: [] }, rawEnv);

    const result = await runChainMigrations({
      rawEnv,
      dryRun: false,
      migrationsOverride: [
        {
          from: 1,
          to: 2,
          description: 'test migration — marks the schema version',
          transformBlock: (block) => ({ ...block, schemaVersion: 2 }),
        },
      ],
    });
    expect(result.ok).toBe(true);
    expect(result.perChain[0]?.blocksMigrated).toBe(2);

    for (const name of ['000001.json', '000002.json']) {
      const written = readFileSync(join(root, 'chains', CHAIN, name), 'utf8');
      expect(written).toBe(serializeBlockForDisk(JSON.parse(written)));
      expect(written).toContain('\n  "index"');
    }
  });

  it('the serializer is one function, and it is the pretty-printed one', () => {
    // The pin itself: if the format ever changes, this is the one place
    // that has to change with it.
    expect(serializeBlockForDisk({ a: 1 })).toBe('{\n  "a": 1\n}');
  });
});
