/**
 * The TypeScript arm of the chain-name contract, checked against the
 * fixture the native arm also reads.
 *
 * `tests/fixtures/chain-name-contract.json` holds the cases; the native
 * runner is `crates/memphis-paths/tests/chain_name_contract.rs`.
 *
 * ## Why this test exists
 *
 * "What is a chain called?" had FOUR owners on this host and THREE
 * answers. This side had the plain-name rule; the native arm carried a
 * copy of it, with a copy of the archive rule beside it; and the native
 * runtime carried a THIRD rule which asked "does the name end in
 * `.backup-<digits>`?" and nothing else.
 *
 * That third rule is the bug. It refused `journal.backup-1784913076785`
 * (a stamp of digits) and ACCEPTED `cases.backup-2026-07-07T15-07-23-108Z`
 * (a stamp of a date) — so the treatment of an archive depended on the
 * SHAPE OF ITS TIMESTAMP rather than on what the directory was.
 *
 * MEASURED 2026-11-23 on the operator's host: the runtime's status
 * counted 11 504 blocks as live memory, the audit counted 11 975, and the
 * live chains hold 11 228. The 276-block gap was one archive of `cases`,
 * counted as if it were the chain itself.
 *
 * The fix is ONE owner (`crates/memphis-paths/src/chain_names.rs`), ONE
 * artefact of cases, and TWO runners. Neither arm produces the artefact
 * alone, so neither can change it alone.
 *
 * ## What this arm checks
 *
 * The classification and the logical chain — the two questions this side
 * answers on its own. The NORMALIZATION is served by the bridge (the
 * owner's own function), so what this arm checks is that the mirror's
 * alias table reproduces the owner's answers: if the table drifted, the
 * normalized names would differ, and the bridge would answer the forward
 * question with a different table than the one this side reads backwards.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import {
  classifyChainDirectory,
  isChainBackupDirectory,
  logicalChainNameForDirectory,
  SAFE_CHAIN_NAME,
  type ChainDirectoryKind,
} from '../../src/memory/chain-catalog.js';
import {
  ARCHIVE_CHAIN_PART_PATTERN,
  ARCHIVE_SEPARATOR,
  ARCHIVE_STAMP_PATTERNS,
  CHAIN_NAME_ALIASES,
  MAX_CHAIN_NAME_LENGTH,
  PLAIN_CHAIN_NAME_PATTERN,
} from '../../src/memory/chain-names.generated.js';

interface ContractCase {
  name: string;
  directory: string;
  kind: ChainDirectoryKind;
  logical: string;
  normalized: string;
}

interface ContractVocabulary {
  plainChainNamePattern: string;
  maxChainNameLength: number;
  archiveChainPartPattern: string;
  archiveSeparator: string;
  archiveStampPatterns: string[];
  chainNameAliases: Array<{ alias: string; canonical: string }>;
}

const here = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE_PATH = path.join(here, '..', 'fixtures', 'chain-name-contract.json');

const fixture = JSON.parse(readFileSync(FIXTURE_PATH, 'utf8')) as {
  vocabulary: ContractVocabulary;
  cases: ContractCase[];
};

/** The mirror's own normalisation: trimmed, then aliased. */
function normalizeThroughMirror(value: string): string {
  const trimmed = value.trim();
  const aliases = CHAIN_NAME_ALIASES as Record<string, string>;
  return aliases[trimmed] ?? trimmed;
}

describe('the chain-name contract — the two arms agree', () => {
  it('holds at least one case', () => {
    expect(fixture.cases.length).toBeGreaterThan(0);
  });

  it('classifies every case the way the contract says', () => {
    for (const testCase of fixture.cases) {
      expect(classifyChainDirectory(testCase.directory), testCase.name).toBe(testCase.kind);
    }
  });

  it('names the chain every directory holds', () => {
    for (const testCase of fixture.cases) {
      expect(logicalChainNameForDirectory(testCase.directory), testCase.name).toBe(
        testCase.logical,
      );
    }
  });

  it('agrees with the archive predicate', () => {
    for (const testCase of fixture.cases) {
      expect(isChainBackupDirectory(testCase.directory), testCase.name).toBe(
        testCase.kind === 'archive',
      );
    }
  });

  it('normalizes every case the way the contract says', () => {
    for (const testCase of fixture.cases) {
      expect(normalizeThroughMirror(testCase.directory), testCase.name).toBe(
        testCase.normalized,
      );
    }
  });

  it('publishes the patterns the contract records', () => {
    const vocabulary = fixture.vocabulary;
    expect(PLAIN_CHAIN_NAME_PATTERN).toBe(vocabulary.plainChainNamePattern);
    expect(ARCHIVE_CHAIN_PART_PATTERN).toBe(vocabulary.archiveChainPartPattern);
    expect(ARCHIVE_SEPARATOR).toBe(vocabulary.archiveSeparator);
    expect(MAX_CHAIN_NAME_LENGTH).toBe(vocabulary.maxChainNameLength);
    expect([...ARCHIVE_STAMP_PATTERNS]).toEqual(vocabulary.archiveStampPatterns);
  });

  it('publishes the alias table the contract records', () => {
    const expected = Object.fromEntries(
      fixture.vocabulary.chainNameAliases.map((entry) => [entry.alias, entry.canonical]),
    );
    expect(CHAIN_NAME_ALIASES).toEqual(expected);
  });

  it('keeps the plain-name rule and the mirror in step', () => {
    expect(SAFE_CHAIN_NAME.source).toBe(PLAIN_CHAIN_NAME_PATTERN);
    expect(SAFE_CHAIN_NAME.test('journal')).toBe(true);
    expect(SAFE_CHAIN_NAME.test('.archives')).toBe(false);
  });
});
