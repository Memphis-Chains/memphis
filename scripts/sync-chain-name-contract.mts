/**
 * Project the chain-name vocabulary from the Rust core into the TypeScript
 * mirror, and check that the two agree.
 *
 * WHY THIS EXISTS
 * ---------------
 * "What is a chain called?" had FOUR answers on this host, and three of them
 * disagreed:
 *
 *   1. `src/memory/chain-catalog.ts` — `SAFE_CHAIN_NAME`, the plain-name
 *      rule, with ten call sites;
 *   2. `crates/memphis-operator/src/chat_memory.rs` — a hand copy of it,
 *      with a hand copy of the archive rule beside it;
 *   3. `crates/memphis-operator/src/runtime.rs` — `is_active_chain_name`, a
 *      THIRD rule, which answered "is this a live chain?" by asking "does
 *      the name end in `.backup-<digits>?`" and nothing else;
 *   4. `crates/memphis-paths/src/lib.rs` — the alias table, copied into
 *      `src/config/paths.ts` a fifth time.
 *
 * Rule (3) is where it hurt. It refused `journal.backup-1784913076785` (a
 * stamp of digits) and ACCEPTED `cases.backup-2026-07-07T15-07-23-108Z` (a
 * stamp of a date), so the treatment of an archive depended on the SHAPE OF
 * ITS TIMESTAMP rather than on what the directory was.
 *
 * MEASURED 2026-11-23 on the operator's host:
 *
 *   - the runtime's status counted **11 504** blocks as live memory,
 *   - the audit counted **11 975**,
 *   - the live chains hold **11 228**,
 *
 * and the 276-block gap between the first two numbers was one archive of
 * `cases`, counted as if it were the chain itself. The same rule counted
 * `.archives` — the dot-directory the rotation writes its `.jsonl.gz` files
 * into — as a chain, so the cockpit listed it as one.
 *
 * THE HOUSE PATTERN
 * -----------------
 * The Rust core owns the vocabulary (`crates/memphis-paths/src/chain_names.rs`
 * — ONE module). This script copies that vocabulary into:
 *
 *   - `tests/fixtures/chain-name-contract.json` — the artefact of cases, and
 *   - `src/memory/chain-names.generated.ts` — the TypeScript mirror, which
 *     is therefore a PROJECTION and not a second hand-written copy.
 *
 * Both sides check themselves against the artefact: the Rust arm in
 * `crates/memphis-paths/tests/chain_name_contract.rs`, the TypeScript arm in
 * `tests/unit/chain-name-contract.test.ts`. Neither produces it alone, so
 * neither can change it alone.
 *
 * THE OWNER IS THE THIRD WITNESS
 * -------------------------------
 * The script reads the vocabulary and every case's verdict through the
 * BUILT BRIDGE — through the owner's own functions, not through a second
 * implementation of the rule written here. A projection that re-implemented
 * the rule would be a fourth copy of it, and the artefact would then be
 * checking the projection against itself.
 *
 * Write: npm run -s ops:sync-chain-name-contract
 * Check: npm run -s ops:sync-chain-name-contract -- --check  (exit 1 on drift)
 */

import { createRequire } from 'node:module';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

import { resolveRustBridgePath } from '../src/infra/runtime/install-root.js';

const FIXTURE = 'tests/fixtures/chain-name-contract.json';
const MIRROR = 'src/memory/chain-names.generated.ts';

/**
 * The corpus of names the vocabulary is exercised against.
 *
 * Every case carries a NAME as well as a directory, so a failure says what
 * broke rather than only what broke. The corpus is fixed and hand-picked:
 * a corpus that grew with the host's disk would make the artefact change
 * every time a chain was rotated, and a gate that changes when nothing
 * changed is a gate nobody reads.
 */
const CORPUS: ReadonlyArray<{ name: string; directory: string }> = [
  // The chains Memphis knows by name.
  { name: 'the journal is a chain', directory: 'journal' },
  { name: 'the decisions are a chain', directory: 'decisions' },
  { name: 'the reflections are a chain', directory: 'reflections' },
  { name: 'the cases are a chain', directory: 'cases' },
  { name: 'the patterns are a chain', directory: 'patterns' },
  { name: 'the soul is a chain', directory: 'soul' },
  { name: 'the system chain is a chain', directory: 'system' },
  { name: 'the collective is a chain', directory: 'collective' },
  { name: 'the insights are a chain', directory: 'insights' },
  { name: 'the proposals are a chain', directory: 'proposals' },
  { name: 'the autonomous archive is a chain', directory: 'autonom_archive' },

  // The singular aliases — a chain NAME, and a chain reference.
  { name: 'the singular alias is a chain', directory: 'case' },
  { name: 'the decision alias is a chain', directory: 'decision' },
  { name: 'the pattern alias is a chain', directory: 'pattern' },
  { name: 'the reflection alias is a chain', directory: 'reflection' },

  // The archives — the same blocks, held as a copy.
  {
    name: 'an archive with an epoch stamp is an archive',
    directory: 'journal.backup-1784913076785',
  },
  {
    name: 'an archive with a dated stamp is an archive',
    directory: 'cases.backup-2026-07-07T15-07-23-108Z',
  },
  {
    name: 'a second archive of another chain is an archive',
    directory: 'system.backup-1782897312539',
  },
  {
    name: 'an archive of a long chain name is still an archive',
    directory: `${'y'.repeat(71)}.backup-123`,
  },

  // The shapes that are not chains.
  {
    name: 'the rotation directory is not a chain',
    directory: '.archives',
  },
  {
    name: 'the quarantine container is a plain name, and the taxonomy decides',
    directory: '_quarantine',
  },
  { name: 'an empty name is not a chain', directory: '' },
  { name: 'a parent traversal is not a chain', directory: '..' },
  { name: 'a nested path is not a chain', directory: 'journal/000001' },
  { name: 'a backslash path is not a chain', directory: 'journal\\000001' },
  { name: 'a dot that is not an archive suffix is not a chain', directory: 'journal.partial' },
  { name: 'a space is not a chain', directory: 'journal backup' },
  { name: 'an archive without a stamp is not an archive', directory: 'journal.backup-' },
  { name: 'an archive with a word stamp is not an archive', directory: 'journal.backup-abc' },
  {
    name: 'an archive with a mixed stamp is not an archive',
    directory: 'journal.backup-123abc',
  },
  {
    name: 'a second separator does not make an archive',
    directory: 'journal.backup-123.backup-456',
  },
  {
    name: 'a dated stamp with a letter in the millis is not an archive',
    directory: 'journal.backup-2026-07-07T15-07-23-10ZZ',
  },
  {
    name: 'a dated stamp with a letter in the middle is not an archive',
    directory: 'journal.backup-2026-07-07T15-07-23-1Z8',
  },

  // The length limit.
  { name: 'a sixty-four character name is a chain', directory: 'x'.repeat(64) },
  { name: 'a sixty-five character name is not a chain', directory: 'x'.repeat(65) },

  // A reference with white space around it.
  { name: 'a padded alias still normalizes', directory: ' case ' },
];

type Alias = { alias: string; canonical: string };

type Vocabulary = {
  plainChainNamePattern: string;
  maxChainNameLength: number;
  archiveChainPartPattern: string;
  archiveSeparator: string;
  archiveStampPatterns: string[];
  chainNameAliases: Alias[];
};

type Facts = {
  kind: 'chain' | 'archive' | 'foreign';
  logical: string;
  normalized: string;
};

type ManifestEnvelope = {
  ok?: boolean;
  data?: Vocabulary;
  error?: string;
};

type FactsEnvelope = {
  ok?: boolean;
  data?: Facts;
  error?: string;
};

type BridgeModule = Record<string, unknown>;

function loadBridge(): { bridge: BridgeModule; path: string } {
  const path = resolveRustBridgePath(process.env);
  if (!existsSync(path)) {
    throw new Error(
      `the native bridge is missing at ${path} — build it first (npm run build:rust:release)`,
    );
  }
  const require = createRequire(`${process.cwd()}/`);
  const bridge = require(path) as BridgeModule;
  return { bridge, path };
}

/** Read the vocabulary from the owner, through the bridge. */
function readVocabulary(bridge: BridgeModule): Vocabulary {
  const manifestFn = bridge.bridge_chain_name_manifest;
  if (typeof manifestFn !== 'function') {
    throw new Error('the bridge does not export bridge_chain_name_manifest');
  }
  const envelope = JSON.parse(String(manifestFn())) as ManifestEnvelope;
  if (!envelope.ok || !envelope.data) {
    throw new Error(`bridge_chain_name_manifest failed: ${envelope.error ?? 'unknown error'}`);
  }
  return envelope.data;
}

/** Read one name's verdict from the owner, through the bridge. */
function readFacts(bridge: BridgeModule, directory: string): Facts {
  const factsFn = bridge.bridge_chain_name_facts;
  if (typeof factsFn !== 'function') {
    throw new Error('the bridge does not export bridge_chain_name_facts');
  }
  const envelope = JSON.parse(String(factsFn(directory))) as FactsEnvelope;
  if (!envelope.ok || !envelope.data) {
    throw new Error(
      `bridge_chain_name_facts failed for ${JSON.stringify(directory)}: ${envelope.error ?? 'unknown error'}`,
    );
  }
  return envelope.data;
}

function buildFixture(vocabulary: Vocabulary, cases: Array<Record<string, unknown>>): string {
  return `${JSON.stringify(
    {
      comment:
        'The chain-name vocabulary — the ONE rule that decides what a directory under `chains/` is. ' +
        'The owner is the Rust core (`crates/memphis-paths/src/chain_names.rs`); the TypeScript arm is a ' +
        'projection of it (`src/memory/chain-names.generated.ts`). Both arms check themselves against THIS ' +
        'file: the Rust runner is `crates/memphis-paths/tests/chain_name_contract.rs`, the TypeScript runner ' +
        'is `tests/unit/chain-name-contract.test.ts`. ' +
        'WHY: the rule had four owners and three answers. Measured 2026-11-23 on the operator\'s host, the ' +
        'runtime counted 11 504 blocks as live memory, the audit counted 11 975, and the live chains hold ' +
        '11 228 — the gap was one archive of `cases` (276 blocks) counted as if it were the chain itself, ' +
        'because the old native rule asked "does the name end in `.backup-<digits>`?" and nothing else. A ' +
        'dated stamp was a live chain; an epoch stamp was not. ' +
        'WHAT: `kind` is `chain`, `archive` or `foreign`; `logical` is the chain a directory holds; ' +
        '`normalized` is the canonical name of a user-supplied reference (trimmed, then aliased — the trim ' +
        'is the caller\'s convention in both arms). ' +
        'The corpus is fixed on purpose: a corpus that grew with the host\'s disk would change the artefact ' +
        'every time a chain was rotated, and a gate that changes when nothing changed is a gate nobody reads.',
      schemaVersion: 1,
      generatedBy: 'scripts/sync-chain-name-contract.mts',
      owner: 'crates/memphis-paths/src/chain_names.rs',
      vocabulary,
      cases,
    },
    null,
    2,
  )}\n`;
}

function buildMirror(vocabulary: Vocabulary): string {
  const aliases = vocabulary.chainNameAliases
    .map((entry) => `  ${entry.alias}: '${entry.canonical}',`)
    .join('\n');
  const stamps = vocabulary.archiveStampPatterns
    .map((pattern) => `  '${pattern}',`)
    .join('\n');

  return `/**
 * The chain-name vocabulary — GENERATED, do not edit.
 *
 * Projected from the Rust core's owner
 * (\`crates/memphis-paths/src/chain_names.rs\`) by
 * \`scripts/sync-chain-name-contract.mts\`. Regenerate with:
 *
 * \`\`\`bash
 * npm run -s ops:sync-chain-name-contract
 * \`\`\`
 *
 * The PATTERNS are the vocabulary; the FUNCTIONS that use them live in
 * \`src/memory/chain-catalog.ts\`. Both sides are checked against the
 * artefact of cases (\`tests/fixtures/chain-name-contract.json\`), so
 * neither this mirror nor the Rust owner can drift from the other
 * without a gate saying so.
 */
export const PLAIN_CHAIN_NAME_PATTERN = '${vocabulary.plainChainNamePattern}';

export const MAX_CHAIN_NAME_LENGTH = ${vocabulary.maxChainNameLength};

export const ARCHIVE_CHAIN_PART_PATTERN = '${vocabulary.archiveChainPartPattern}';

export const ARCHIVE_SEPARATOR = '${vocabulary.archiveSeparator}';

export const ARCHIVE_STAMP_PATTERNS = [
${stamps}
] as const;

export const CHAIN_NAME_ALIASES = {
${aliases}
} as const;

export type ChainNameAlias = keyof typeof CHAIN_NAME_ALIASES;
`;
}

function main(): number {
  const check = process.argv.includes('--check');
  const { bridge, path: bridgePath } = loadBridge();
  const vocabulary = readVocabulary(bridge);

  const cases = CORPUS.map((entry) => {
    const facts = readFacts(bridge, entry.directory);
    return {
      name: entry.name,
      directory: entry.directory,
      kind: facts.kind,
      logical: facts.logical,
      normalized: facts.normalized,
    };
  });

  const fixture = buildFixture(vocabulary, cases);
  const mirror = buildMirror(vocabulary);

  if (check) {
    const problems: string[] = [];
    for (const [label, path, expected] of [
      ['fixture', FIXTURE, fixture],
      ['mirror', MIRROR, mirror],
    ] as const) {
      if (!existsSync(path)) {
        problems.push(`${label} ${path} does not exist`);
        continue;
      }
      if (readFileSync(path, 'utf8') !== expected) {
        problems.push(`${label} ${path} is stale`);
      }
    }
    if (problems.length > 0) {
      console.error('chain name contract gate FAILED\n');
      for (const problem of problems) console.error(`  ${problem}`);
      console.error('');
      console.error('  Run: npm run -s ops:sync-chain-name-contract');
      return 1;
    }
    console.log(
      `[chain-name-contract] OK (${cases.length} cases, mirror in sync with the Rust core)`,
    );
    return 0;
  }

  mkdirSync(dirname(resolve(FIXTURE)), { recursive: true });
  writeFileSync(FIXTURE, fixture, 'utf8');
  writeFileSync(MIRROR, mirror, 'utf8');
  console.log(
    `[chain-name-contract] wrote ${FIXTURE} and ${MIRROR} (${cases.length} cases, bridge ${bridgePath})`,
  );
  return 0;
}

process.exit(main());
