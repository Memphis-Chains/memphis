/**
 * Regenerate the chain-invariant golden fixture.
 *
 * WHY THIS EXISTS
 *
 * The fixture the sweep gate runs against was written by hand with
 * placeholder hashes (`"sha256-journal-000001"`) and a block type the
 * native core does not know (`soul`). It was fine while the sweep's
 * oracle was "the file parses as JSON" — but the sweep now asks the
 * core (S1, 2026-11-04), and the core is a closed serde enum that
 * checks the hash. A fixture the core rejects would fail the gate for a
 * reason that has nothing to do with the runtime.
 *
 * So the fixture is GENERATED: real hashes, real types, real linkage.
 * The gate that runs it is the check — if the fixture and the core ever
 * disagree, the sweep fails and says which block.
 *
 * USAGE
 *   npm run -s ops:chain-fixture
 *
 * The hashes are computed with the same canonical projection the core
 * uses (`crates/memphis-core/src/hash.rs:5`): `data` reduced to
 * `type` / `content` / `tags`, the rest of the block hashed as it
 * stands.
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { stableStringify } from '../src/core/stable-stringify.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURE_DIR = join(HERE, '..', 'tests', 'fixtures', 'chain-invariant');
const GENESIS_PREV_HASH = '0'.repeat(64);

interface FixtureBlock {
  readonly index: number;
  readonly timestamp: string;
  readonly chain: string;
  readonly data: { readonly type: string; readonly content: string; readonly tags: string[] };
  readonly prev_hash: string;
  readonly hash: string;
}

/**
 * The canonical hash the core computes. `data` is reduced to three
 * fields; everything else in the block is hashed as it stands.
 */
function canonicalHash(block: Omit<FixtureBlock, 'hash'>): string {
  const canonical = stableStringify({
    ...block,
    data: {
      type: block.data.type,
      content: block.data.content,
      tags: block.data.tags,
    },
  });
  return createHash('sha256').update(canonical).digest('hex');
}

/**
 * The chains the fixture holds.
 *
 * The types are the ones the native core knows: `journal` and `decision`
 * are variants of `BlockType`; the soul chain uses `case`, which is
 * what the real soul chain writes (`src/memory/chain-catalog.ts`).
 */
const CHAINS: ReadonlyArray<{
  readonly name: string;
  readonly blocks: ReadonlyArray<{
    readonly type: string;
    readonly content: string;
    readonly tags: readonly string[];
  }>;
}> = [
  {
    name: 'journal',
    blocks: [
      { type: 'journal', content: 'golden-fixture-block-0', tags: ['fixture'] },
      { type: 'journal', content: 'golden-fixture-block-1', tags: ['fixture'] },
    ],
  },
  {
    name: 'decisions',
    blocks: [{ type: 'decision', content: 'golden-fixture-decision-0', tags: ['fixture'] }],
  },
  {
    name: 'soul',
    blocks: [{ type: 'case', content: 'golden-fixture-soul-0', tags: ['fixture'] }],
  },
];

let written = 0;
for (const chain of CHAINS) {
  const directory = join(FIXTURE_DIR, chain.name);
  mkdirSync(directory, { recursive: true });

  let prevHash = GENESIS_PREV_HASH;
  for (const [index, spec] of chain.blocks.entries()) {
    const block = {
      index,
      timestamp: `2026-01-01T00:0${index}:00.000Z`,
      chain: chain.name,
      data: { type: spec.type, content: spec.content, tags: [...spec.tags] },
      prev_hash: prevHash,
    };
    const hash = canonicalHash(block);
    prevHash = hash;

    const file = join(directory, `${String(index).padStart(6, '0')}.json`);
    writeFileSync(file, `${JSON.stringify({ ...block, hash }, null, 2)}\n`, 'utf8');
    written += 1;
  }
}

console.log(`chain-invariant fixture: ${written} block(s) written to ${FIXTURE_DIR}`);
