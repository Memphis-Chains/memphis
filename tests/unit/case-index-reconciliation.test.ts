/**
 * The case index is a CACHE of the chain, and the chain is the truth.
 *
 * ## Why this gate exists
 *
 * MEASURED 2026-11-24 on the operator's host:
 *
 * | | |
 * | --- | --- |
 * | the `cases` chain | **2 190** case blocks (accusative 2 058, genitive 129, instrumental 2, nominative 1) |
 * | `~/.memphis/case-index.sqlite` | **1 372** rows (accusative 1 313, genitive 59) |
 * | the index's block_index range | **818 … 2 189** — the chain's LAST block |
 *
 * So the index had lost the **first 818** entries, and the missing ones
 * included the host's ONLY nominative entry and BOTH instrumental ones.
 * The two paths of the same adapter answered different questions: the
 * Rust path (the index — the LIVE one, `RUST_CHAIN_ENABLED=true`)
 * answered 1 372, the TypeScript path (the chain files) answered 2 190.
 *
 * Nothing noticed, because the index's HIGHEST block index was the
 * chain's last: every signal that looks at the tail said "fine". And
 * the mechanism that was written to repair exactly this state —
 * `reconcileIfNeeded()`, whose own doc says *"Ensures the index matches
 * the filesystem after a potential partial write"* — had **no caller in
 * the tree**, and neither did `rebuildIndex()` beside it.
 *
 * ## What this gate pins
 *
 * 1. A query answers with the WHOLE truth, even when the index behind it
 *    is behind the chain — the adapter repairs the cache first.
 * 2. The repair is not repeated for ever: the second reconciliation has
 *    nothing to do, because the rebuild made the counts equal.
 * 3. The owner can be ASKED how many entries the index holds — the
 *    count, because the count is the only signal that sees a gap at the
 *    HEAD.
 *
 * The Rust arm of the same contract is
 * `crates/memphis-case-index/src/lib.rs` (the `status()` tests) and
 * `crates/memphis-napi/tests/bridge_payload_contract.rs` (the shape).
 */

import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { resolveRustBridgePath } from '../../src/infra/runtime/install-root.js';
import type { BlockPayload } from '../../src/infra/storage/bridge-payloads.generated.js';
import { CaseChainAdapter } from '../../src/infra/storage/case-chain-adapter.js';

const require = createRequire(`${process.cwd()}/`);

type Bridge = Record<string, unknown>;

function loadBridge(): Bridge | null {
  const path = resolveRustBridgePath(process.env);
  if (!existsSync(path)) return null;
  try {
    return require(path) as Bridge;
  } catch {
    return null;
  }
}

const bridge = loadBridge();

const CASES: Array<Record<string, string>> = [
  {
    case_type: 'nominative',
    entity: 'Kot',
    action: 'szedl',
    timestamp: '2026-11-24T10:00:00.000Z',
  },
  { case_type: 'genitive', owner: 'Kota', possessed: 'dom' },
  { case_type: 'instrumental', actor: 'Kot', instrument: 'kij', target: 'pies' },
  { case_type: 'accusative', subject: 'Kot', verb: 'goni', object: 'mysza' },
];

const scratch = mkdtempSync(join(tmpdir(), 'memphis-case-index-reconcile-'));
const dataDir = join(scratch, 'data');
const chainDir = join(dataDir, 'chains', 'cases');
const indexPath = join(dataDir, 'case-index.sqlite');

const rawEnv: NodeJS.ProcessEnv = {
  ...process.env,
  MEMPHIS_DATA_DIR: dataDir,
  RUST_CHAIN_ENABLED: 'true',
};

/** The blocks the chain holds — built through the bridge's own append. */
function buildChain(): BlockPayload[] {
  const append = bridge?.case_append as
    | ((chainJson: string, entryJson: string, indexDbPath: string, source?: string) => string)
    | undefined;
  if (typeof append !== 'function') return [];

  let blocks: BlockPayload[] = [];
  for (const entry of CASES) {
    const envelope = JSON.parse(
      append(JSON.stringify(blocks), JSON.stringify(entry), indexPath, SOURCE),
    ) as { ok: boolean; data?: { chain?: BlockPayload[] }; error?: string };
    if (!envelope.ok || !envelope.data?.chain) {
      throw new Error(`case_append failed: ${envelope.error ?? 'unknown error'}`);
    }
    blocks = envelope.data.chain;
  }
  return blocks;
}

/** The chain's blocks, written where the adapter reads them. */
function writeChainFiles(blocks: BlockPayload[]): void {
  mkdirSync(chainDir, { recursive: true });
  for (const block of blocks) {
    writeFileSync(
      join(chainDir, `${String(block.index).padStart(6, '0')}.json`),
      `${JSON.stringify(block, null, 2)}\n`,
      'utf8',
    );
  }
}

/**
 * An index that holds the chain's blocks EXCEPT THE FIRST ONE.
 *
 * THE GAP AT THE HEAD — the operator's host's state. The index held the
 * chain's LAST block (2 189 of 2 190) and was missing the first 818, so
 * every signal that looks at the tail said "fine". A fixture with the gap
 * at the tail would not reproduce it: there the highest index would
 * already differ from the chain's last.
 */
/**
 * The SOURCE the adapter indexes under: the chain DIRECTORY it reads.
 *
 * The index is keyed by it, so a helper that builds an index has to build
 * it in the SAME bucket the adapter asks about — otherwise the helper
 * measures a different index than the one under test.
 */
const SOURCE = 'cases';

function buildBehindIndex(blocks: BlockPayload[]): void {
  const rebuild = bridge?.case_rebuild as
    | ((blocksJson: string, indexDbPath: string, source?: string) => string)
    | undefined;
  if (typeof rebuild !== 'function') return;
  const envelope = JSON.parse(rebuild(JSON.stringify(blocks.slice(1)), indexPath, SOURCE)) as {
    ok: boolean;
    data?: { indexed?: number };
    error?: string;
  };
  if (!envelope.ok) throw new Error(`case_rebuild failed: ${envelope.error ?? 'unknown error'}`);
}

describe('the case index is reconciled with the chain it caches', () => {
  let blocks: BlockPayload[] = [];

  beforeAll(() => {
    if (!bridge) return;
    blocks = buildChain();
    writeChainFiles(blocks);
    // The index is built from the chain WITHOUT its last block — the state
    // an index born mid-chain is in, and the state the operator's host was
    // in (1 372 of 2 190).
    buildBehindIndex(blocks);
  });

  afterAll(() => {
    rmSync(scratch, { recursive: true, force: true });
  });

  it('the index really is behind the chain before anything repairs it', () => {
    if (!bridge) return;

    const statusFn = bridge.case_index_status as
      | ((indexDbPath: string, source?: string) => string)
      | undefined;
    expect(typeof statusFn, 'the bridge cannot be asked about the index').toBe('function');

    const status = JSON.parse(statusFn!(indexPath, SOURCE)) as {
      ok: boolean;
      data?: {
        indexed: number;
        lastIndexedBlock: number | null;
        sourceAware: boolean;
        source: string;
      };
    };
    expect(status.ok).toBe(true);
    expect(status.data!.indexed).toBe(blocks.length - 1);
  });

  it('the owner counts the entries, and the count is what sees a gap', () => {
    if (!bridge) return;

    const statusFn = bridge.case_index_status as (indexDbPath: string, source?: string) => string;
    const status = JSON.parse(statusFn(indexPath, SOURCE)) as {
      data?: { indexed: number; lastIndexedBlock: number | null };
    };

    // The index's HIGHEST block is the chain's last one — so the highest
    // index cannot see the gap. The COUNT can.
    expect(status.data!.lastIndexedBlock).toBe(blocks.length - 1);
    expect(status.data!.indexed).toBe(blocks.length - 1);
    expect(status.data!.indexed).not.toBe(blocks.length);
  });

  it('a query answers with the whole truth, not a subset of it', async () => {
    if (!bridge) return;

    // The index is behind AGAIN — so this is the query path's OWN
    // repair, not the one the reconciliation test made.
    buildBehindIndex(blocks);

    const adapter = new CaseChainAdapter(rawEnv);
    const result = await adapter.queryCases({ limit: 100 });

    // Before the repair this was `blocks.length - 1` — the SUBSET, and a
    // subset looks exactly like an answer.
    expect(result.count).toBe(blocks.length);
    const types = result.entries.map((entry) => entry.entry.case_type).sort();
    expect(types).toEqual(CASES.map((entry) => entry.case_type).sort());
  });

  it('the repair is not repeated for ever', async () => {
    if (!bridge) return;

    // The index is behind again — this test is about what happens AFTER
    // the repair, so it must start from the broken state.
    buildBehindIndex(blocks);

    const adapter = new CaseChainAdapter(rawEnv);

    // The first reconciliation has work to do — the index is behind.
    const first = await adapter.reconcileIfNeeded();
    expect(first, 'the first reconciliation did nothing').not.toBeNull();
    expect(first!.indexed).toBe(blocks.length);

    // The second has NOTHING to do: the rebuild made the counts equal,
    // and equal counts are the whole check. A check that could fire
    // again would rebuild the index on every query for ever.
    const second = await adapter.reconcileIfNeeded();
    expect(second, 'the second reconciliation rebuilt again').toBeNull();
  });

  it('the adapter indexes under the chain DIRECTORY it reads', async () => {
    if (!bridge) return;

    buildBehindIndex(blocks);

    const adapter = new CaseChainAdapter(rawEnv);
    await adapter.reconcileIfNeeded();

    const statusFn = bridge.case_index_status as (indexDbPath: string, source?: string) => string;

    // The source's bucket holds the chain's cases.
    const named = JSON.parse(statusFn(indexPath, SOURCE)) as {
      data?: { indexed: number; source: string; sourceAware: boolean };
    };
    expect(named.data!.indexed).toBe(blocks.length);
    expect(named.data!.source).toBe(SOURCE);

    // And the LEGACY bucket — the one a caller that does not name a source
    // reads — is empty. That is the proof the adapter threaded the source
    // rather than writing into the old global bucket: both buckets would
    // hold the same rows otherwise.
    const legacy = JSON.parse(statusFn(indexPath)) as {
      data?: { indexed: number };
    };
    expect(legacy.data!.indexed).toBe(0);
  });

  it('the bridge says whether it understands the source', () => {
    if (!bridge) return;

    const statusFn = bridge.case_index_status as (indexDbPath: string, source?: string) => string;
    const status = JSON.parse(statusFn(indexPath, SOURCE)) as {
      data?: { sourceAware: boolean };
    };

    // The handshake the compatibility window is read through: a caller
    // that does not find this flag knows the binary in front of it
    // predates the source, and keeps using the legacy calls.
    expect(status.data!.sourceAware).toBe(true);
  });
});
