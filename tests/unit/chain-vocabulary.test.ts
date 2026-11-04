/**
 * S1 · one registry, one vocabulary.
 *
 * The two halves of this stage are the same mistake seen twice: a second
 * list of chain names, and a second notion of a legal block.
 *
 *   - the REGISTRY: which directories under `chains/` are chains, and
 *     which of them the verifier opens. Measured on this host, 2026-11-04:
 *     the allowlist carried three archives the scanner could not open,
 *     and `chain verify --chain journal.backup-1784913076785` answered
 *     `ok: true` after checking NOTHING.
 *   - the VOCABULARY: which block types the native core can deserialize.
 *     The core owns a closed serde enum and it is also the thing that
 *     WRITES, so a block it cannot read is a block the runtime cannot
 *     use. Measured on the same host: exactly TWO of 23 391 blocks.
 *
 * The tests below are hermetic: no native bridge, no operator data. The
 * core is replaced by a vocabulary that answers for a fixed set of
 * types, and the disk by a temp directory.
 */

import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  canonicalHash,
  inferBlockType,
  normalizeBlockData,
  parseRawChainBlock,
  repairChainDirectoryVocabulary,
} from '../../src/infra/runtime/chain-canonical.js';
import { scanChainVocabulary } from '../../src/infra/runtime/chain-vocabulary-repair.js';
import type {
  BlockTypeVerdict,
  BlockVocabulary,
} from '../../src/infra/storage/block-vocabulary.js';
import {
  deriveChainRegistry,
  getChainAllowlist,
  isScannableChainDirectoryName,
} from '../../src/infra/storage/chain-adapter.js';
import {
  getConditionalChainNames,
  getStandardChainNames,
  isChainBackupDirectory,
  logicalChainNameForDirectory,
} from '../../src/memory/chain-catalog.js';

/* ------------------------------------------------------------------ */
/* a vocabulary that answers without a native bridge                   */
/* ------------------------------------------------------------------ */

/**
 * The core's enum, minus the aliases: the variants the native core
 * deserializes as themselves (`crates/memphis-core/src/block.rs:5`).
 */
const CORE_VARIANTS = new Set([
  'journal',
  'ask',
  'decision',
  'system',
  'system_event',
  'insight',
  'tool_call',
  'tool_result',
  'error',
  'case',
  'wallet_tx_requested',
  'wallet_tx_signed',
  'wallet_tx_broadcast',
  'wallet_tx_confirmed',
  'wallet_tx_failed',
]);

/** The read-side aliases the enum accepts for `system_event`. */
const CORE_ALIASES = new Set([
  'security_event',
  'boot',
  'health_state_change',
  'memory.action',
  'memory.burn',
  'model-d-proposal',
  'mode_change',
  'consent.annotation',
  'scheduler_task',
  'chain.repair',
  'config',
  'reflection_report',
  'categorize_report',
  'unknown',
]);

function fakeVocabulary(
  known: readonly string[] = [...CORE_VARIANTS, ...CORE_ALIASES],
): BlockVocabulary {
  const knownSet = new Set(known);
  return {
    available: () => true,
    isKnown: (type) => knownSet.has(type),
    verdict: (type): BlockTypeVerdict =>
      knownSet.has(type)
        ? { type, known: true }
        : { type, known: false, error: `invalid_block_json: unknown variant \`${type}\`` },
    complaint: (block) => {
      const type = block.data.type;
      if (typeof type !== 'string') return 'invalid_block_json: missing field `type`';
      return knownSet.has(type) ? null : `invalid_block_json: unknown variant \`${type}\``;
    },
  };
}

/* ------------------------------------------------------------------ */
/* the registry                                                        */
/* ------------------------------------------------------------------ */

describe('S1 · the registry is one list', () => {
  let dataDir: string;

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), 'memphis-s1-registry-'));
    mkdirSync(join(dataDir, 'chains'), { recursive: true });
  });

  afterEach(() => {
    rmSync(dataDir, { recursive: true, force: true });
  });

  function makeDir(name: string): string {
    const dir = join(dataDir, 'chains', name);
    mkdirSync(dir, { recursive: true });
    return dir;
  }

  const env = () => ({ MEMPHIS_DATA_DIR: dataDir }) as NodeJS.ProcessEnv;

  it('knows which chains are planned and which are standard', () => {
    // `proactive` and `messages` belong to features that may be off. A
    // host without them is healthy — the audit must say so, or every
    // fresh install audits red forever.
    expect(getConditionalChainNames()).toContain('proactive');
    expect(getConditionalChainNames()).toContain('messages');
    expect(getStandardChainNames()).toContain('journal');
    expect(getStandardChainNames()).not.toContain('proactive');
  });

  it('reads the logical chain out of an archive directory name', () => {
    expect(logicalChainNameForDirectory('journal')).toBe('journal');
    expect(logicalChainNameForDirectory('journal.backup-1784913076785')).toBe('journal');
    expect(logicalChainNameForDirectory('cases.backup-2026-07-07T15-07-23-108Z')).toBe('cases');
    expect(isChainBackupDirectory('journal.backup-1784913076785')).toBe(true);
    expect(isChainBackupDirectory('journal')).toBe(false);
  });

  it('opens an archive as readily as a chain', () => {
    // The hole: the scanner's name pattern had no dot in it, so the
    // three archives the operator had explicitly listed could not be
    // opened by it — and `chain verify --chain journal.backup-…`
    // answered `ok: true` after checking nothing.
    expect(isScannableChainDirectoryName('journal')).toBe(true);
    expect(isScannableChainDirectoryName('journal.backup-1784913076785')).toBe(true);
    expect(isScannableChainDirectoryName('_quarantine')).toBe(true);
    expect(isScannableChainDirectoryName('../etc')).toBe(false);
    expect(isScannableChainDirectoryName('journal.backup-../../etc')).toBe(false);
  });

  it('registers the chains and their archives, and nothing else', () => {
    makeDir('journal');
    makeDir('decisions');
    makeDir('journal.backup-1784913076785');
    makeDir('_quarantine');
    makeDir('not-a-chain');

    const registry = deriveChainRegistry(env());
    expect([...registry].sort()).toEqual(['decisions', 'journal', 'journal.backup-1784913076785']);
  });

  it('lets the config narrow the registry, never widen it', () => {
    makeDir('journal');
    makeDir('decisions');
    makeDir('journal.backup-1784913076785');

    const narrowed = getChainAllowlist({
      ...env(),
      MEMPHIS_CHAINS_ALLOWLIST: 'journal,journal.backup-1784913076785',
    });
    expect([...narrowed].sort()).toEqual(['journal', 'journal.backup-1784913076785']);

    // A name the registry does not know is NOT added. The old behaviour
    // REPLACED the code default with the config, which is how a
    // forgotten chain became a silent skip.
    const widened = getChainAllowlist({
      ...env(),
      MEMPHIS_CHAINS_ALLOWLIST: 'journal,ghost',
    });
    expect([...widened].sort()).toEqual(['journal']);
  });
});

/* ------------------------------------------------------------------ */
/* the vocabulary                                                      */
/* ------------------------------------------------------------------ */

describe('S1 · the vocabulary is the core’s', () => {
  it('rewrites an unknown type into the canonical shape', () => {
    const vocabulary = fakeVocabulary();
    const data = normalizeBlockData(
      'autonom_archive',
      { type: 'autonom_publication', content: 'payload', tags: ['archive'] },
      { vocabulary },
    );
    expect(data.type).toBe('system_event');
    expect(data.kind).toBe('autonom_publication');
    expect(data.content).toBe('payload');
    expect(data.tags).toEqual(['archive']);
  });

  it('keeps a type the core knows', () => {
    const vocabulary = fakeVocabulary();
    const data = normalizeBlockData(
      'journal',
      { type: 'journal', content: 'payload', tags: [] },
      { vocabulary },
    );
    expect(data.type).toBe('journal');
    expect(data.kind).toBeUndefined();
  });

  it('infers a missing type from the chain, not from `kind`', () => {
    // `kind` is the semantic name that travels WITH `system_event`.
    // Promoting it to a type is how a block ended up claiming a type
    // the core does not know.
    const vocabulary = fakeVocabulary();
    expect(inferBlockType('journal', { kind: 'pattern' }, vocabulary)).toBe('journal');
    expect(inferBlockType('decisions', {}, vocabulary)).toBe('decision');
  });

  it('never overwrites a `kind` the block already carries', () => {
    const vocabulary = fakeVocabulary();
    const data = normalizeBlockData(
      'autonom_archive',
      { type: 'autonom_publication', kind: 'publication', content: 'payload', tags: [] },
      { vocabulary },
    );
    expect(data.type).toBe('system_event');
    expect(data.kind).toBe('publication');
  });
});

/* ------------------------------------------------------------------ */
/* the repair                                                          */
/* ------------------------------------------------------------------ */

describe('S1 · the repair rewrites only what the core refuses', () => {
  let dataDir: string;

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), 'memphis-s1-repair-'));
    mkdirSync(join(dataDir, 'chains'), { recursive: true });
  });

  afterEach(() => {
    rmSync(dataDir, { recursive: true, force: true });
  });

  const env = () => ({ MEMPHIS_DATA_DIR: dataDir }) as NodeJS.ProcessEnv;

  function writeBlock(dir: string, file: string, block: Record<string, unknown>): void {
    const target = join(dataDir, 'chains', dir);
    mkdirSync(target, { recursive: true });
    writeFileSync(join(target, file), `${JSON.stringify(block, null, 2)}\n`, 'utf8');
  }

  function readBlock(dir: string, file: string): Record<string, unknown> {
    return JSON.parse(readFileSync(join(dataDir, 'chains', dir, file), 'utf8')) as Record<
      string,
      unknown
    >;
  }

  it('rewrites the offending block and leaves the rest byte-identical', () => {
    const vocabulary = fakeVocabulary();
    const good = {
      index: 0,
      timestamp: '2026-01-01T00:00:00.000Z',
      chain: 'journal',
      data: { type: 'journal', content: 'first', tags: [] },
      prev_hash: '0'.repeat(64),
    };
    const bad = {
      index: 1,
      timestamp: '2026-01-01T00:01:00.000Z',
      chain: 'journal',
      data: { type: 'autonom_publication', content: 'second', tags: [] },
      prev_hash: canonicalHash(good),
    };
    writeBlock('journal', '000000.json', { ...good, hash: canonicalHash(good) });
    writeBlock('journal', '000001.json', { ...bad, hash: canonicalHash(bad) });
    const before = readFileSync(join(dataDir, 'chains', 'journal', '000000.json'), 'utf8');

    const applied: string[] = [];
    const warnings: string[] = [];
    const outcome = repairChainDirectoryVocabulary(
      'journal',
      join(dataDir, 'chains', 'journal'),
      applied,
      warnings,
      {
        vocabulary,
      },
    );

    expect(outcome.blocksRewritten).toBe(1);
    expect(warnings).toEqual([]);

    // The first block was not touched — byte for byte.
    expect(readFileSync(join(dataDir, 'chains', 'journal', '000000.json'), 'utf8')).toBe(before);

    // The second one now carries a type the core knows, and the original
    // semantic name moved to `kind`.
    const repaired = readBlock('journal', '000001.json');
    expect((repaired.data as Record<string, unknown>).type).toBe('system_event');
    expect((repaired.data as Record<string, unknown>).kind).toBe('autonom_publication');
  });

  it('re-links the hash chain after the repaired block', () => {
    const vocabulary = fakeVocabulary();
    const first = {
      index: 0,
      timestamp: '2026-01-01T00:00:00.000Z',
      chain: 'journal',
      data: { type: 'journal', content: 'first', tags: [] },
      prev_hash: '0'.repeat(64),
    };
    const bad = {
      index: 1,
      timestamp: '2026-01-01T00:01:00.000Z',
      chain: 'journal',
      data: { type: 'journal', content: 'second', tags: [] },
      prev_hash: canonicalHash(first),
    };
    const third = {
      index: 2,
      timestamp: '2026-01-01T00:02:00.000Z',
      chain: 'journal',
      data: { type: 'journal', content: 'third', tags: [] },
      prev_hash: canonicalHash(bad),
    };
    writeBlock('journal', '000000.json', { ...first, hash: canonicalHash(first) });
    writeBlock('journal', '000001.json', { ...bad, hash: canonicalHash(bad) });
    writeBlock('journal', '000002.json', { ...third, hash: canonicalHash(third) });

    const applied: string[] = [];
    const warnings: string[] = [];
    repairChainDirectoryVocabulary(
      'journal',
      join(dataDir, 'chains', 'journal'),
      applied,
      warnings,
      {
        vocabulary,
      },
    );

    // The repaired block's data changed → its hash changed → the block
    // after it must point at the NEW hash, or the chain is broken.
    const repairedSecond = readBlock('journal', '000001.json');
    const thirdBlock = readBlock('journal', '000002.json');
    expect(thirdBlock.prev_hash).toBe(repairedSecond.hash);
    expect(thirdBlock.hash).toBe(
      canonicalHash({
        index: third.index,
        timestamp: third.timestamp,
        chain: third.chain,
        data: third.data,
        prev_hash: thirdBlock.prev_hash,
      }),
    );
  });

  it('refuses to guess when a file is not a readable block', () => {
    const vocabulary = fakeVocabulary();
    mkdirSync(join(dataDir, 'chains', 'journal'), { recursive: true });
    writeFileSync(join(dataDir, 'chains', 'journal', '000000.json'), '{ not json', 'utf8');

    const applied: string[] = [];
    const warnings: string[] = [];
    const outcome = repairChainDirectoryVocabulary(
      'journal',
      join(dataDir, 'chains', 'journal'),
      applied,
      warnings,
      {
        vocabulary,
      },
    );

    expect(outcome.blocksRewritten).toBe(0);
    expect(warnings.join(' ')).toContain('not readable blocks');
    // The unreadable file was left exactly as it was.
    expect(readFileSync(join(dataDir, 'chains', 'journal', '000000.json'), 'utf8')).toBe(
      '{ not json',
    );
  });

  it('scans the archives too — the hole the verifier had', () => {
    const vocabulary = fakeVocabulary();
    const bad = {
      index: 0,
      timestamp: '2026-01-01T00:00:00.000Z',
      chain: 'journal',
      data: { type: 'autonom_publication', content: 'archived', tags: [] },
      prev_hash: '0'.repeat(64),
    };
    writeBlock('journal.backup-1784913076785', '000000.json', { ...bad, hash: canonicalHash(bad) });

    const scan = scanChainVocabulary(env(), vocabulary);
    expect(scan.chainsScanned).toBe(1);
    expect(scan.unreadable).toHaveLength(1);
    expect(scan.unreadable[0]?.directory).toBe('journal.backup-1784913076785');
    expect(scan.unreadable[0]?.chain).toBe('journal');
  });

  it('leaves a chain the core can read completely alone', () => {
    const vocabulary = fakeVocabulary();
    const good = {
      index: 0,
      timestamp: '2026-01-01T00:00:00.000Z',
      chain: 'journal',
      data: { type: 'journal', content: 'fine', tags: [] },
      prev_hash: '0'.repeat(64),
    };
    writeBlock('journal', '000000.json', { ...good, hash: canonicalHash(good) });
    const before = readFileSync(join(dataDir, 'chains', 'journal', '000000.json'), 'utf8');

    const applied: string[] = [];
    const warnings: string[] = [];
    const outcome = repairChainDirectoryVocabulary(
      'journal',
      join(dataDir, 'chains', 'journal'),
      applied,
      warnings,
      {
        vocabulary,
      },
    );

    expect(outcome.blocksRewritten).toBe(0);
    expect(readFileSync(join(dataDir, 'chains', 'journal', '000000.json'), 'utf8')).toBe(before);
  });

  it('parses a block without judging it', () => {
    expect(parseRawChainBlock('{ not json')).toBeNull();
    expect(parseRawChainBlock('{"index":1}')).toBeNull();
    const block = parseRawChainBlock(
      JSON.stringify({
        index: 1,
        timestamp: '2026-01-01T00:00:00.000Z',
        chain: 'journal',
        data: { type: 'journal', content: 'x', tags: [] },
        prev_hash: '0'.repeat(64),
        hash: 'a'.repeat(64),
      }),
    );
    expect(block?.index).toBe(1);
  });
});
