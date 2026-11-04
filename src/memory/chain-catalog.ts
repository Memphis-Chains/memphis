/**
 * Canonical Memphis chain catalog — single source of truth (Sprint 0.5 G2).
 *
 * Before this module, chain name lists drifted across three places:
 *   - disk reality under ~/.memphis/chains/
 *   - src/soul/manifest.ts `KNOWN_CHAINS` (8 chains, including phantom
 *     `proactive` which on some installs exists but isn't universal, and
 *     missing `insights` + `soul` which are real)
 *   - src/gateway/system-prompt.ts `CHAINS` (4 chains — a docs subset)
 *   - src/infra/runtime/runtime-health.ts — its own list
 *   - src/infra/memory/embed-reindex.ts `SEARCHABLE_CHAINS` — yet another
 *
 * Authoritative here. Every other consumer should import from this module
 * instead of maintaining a parallel list. Adding a new chain is a single-
 * file change now; enriches documentation, readiness checks, and the LLM's
 * view of memory simultaneously.
 *
 * Each chain entry carries enough metadata that downstream consumers can
 * render docs (system-prompt), gate search indexing (embed-reindex), and
 * drive readiness checks (runtime-health, doctor) without needing to
 * hand-code their own knowledge of what each chain is for.
 *
 * THE CATALOG IS NOT A PROMISE ABOUT THE DISK
 *
 * Chains are created by their first writer, so a fresh install has fewer
 * directories than the catalog names — and two entries (`proactive`,
 * `messages`) belong to features that may be off entirely. The
 * `availability` flag says which absences are drift and which are health.
 * Without it, every audit of a fresh install reports a permanent red
 * (measured: the audit named `proactive, messages` as registry drift on
 * a host where both absences were correct).
 */

export type ConsentDefault = 'exportable' | 'local-only' | 'anonymized';

export interface ChainDefinition {
  /** Directory name under ~/.memphis/chains/<name>/ */
  name: string;
  /** One-line description for system prompt + docs. */
  purpose: string;
  /**
   * `data.type` values that typically land in this chain. This is
   * taxonomy, not enforcement — the Rust block validator accepts any
   * `data.type` string that isn't empty. Downstream consumers (auto-gen
   * docs, migration tooling) treat this as hints, not constraints.
   *
   * The RUST CORE is stricter than that sentence suggests. `BlockType`
   * (crates/memphis-core/src/block.rs:5) is a closed serde enum, and a
   * block whose `data.type` is not one of its variants fails to
   * deserialize — measured on this host: `chain_validate` on a block of
   * type `autonom_publication` returns `invalid_block_json: unknown
   * variant`. The validator is permissive; the deserializer runs first and
   * is not. A new chain therefore has to use a type the enum knows, which
   * is what `block.rs:19` prescribes: `system_event` with the semantic
   * name in `kind`. See docs/design/DREAMING-GAPS-AND-REFACTOR.md §3.1.
   */
  blockTypes: string[];
  /**
   * Rough write volume. Used by embed-reindex to prioritise which
   * chains to re-index first on a cold rebuild, and by `memphis doctor`
   * to set expectations for "empty chain" warnings.
   */
  writeFrequency: 'high' | 'medium' | 'low';
  /**
   * Default privacy/consent level for new blocks in this chain. Overridable
   * per-block via `memphis consent mark`. Chains holding operator-private
   * content (journal, cases) default to `local-only`; shared-training-
   * safe chains (decisions, patterns, reflections, system) default to
   * `exportable` so the operator can opt into training corpus export
   * without per-block marking.
   */
  consentDefault: ConsentDefault;
  /**
   * Whether blocks in this chain should be indexed for semantic + exact
   * search. `system` blocks are excluded because they're raw audit rows
   * (tool_call, tool_result, heartbeat noise) that pollute search
   * results. `soul` likewise: identity/memory rows, operator-facing
   * via dedicated soul tools, not chain search.
   */
  searchable: boolean;
  /**
   * Whether the chain is expected to be present on a live host.
   *
   * - `standard` — part of the ordinary install. Its absence on the disk
   *   is worth a report; the registry counts it.
   * - `conditional` — belongs to a feature that may legitimately be off
   *   (`messages`: federation) or is written only opportunistically
   *   (`proactive`: the assistant's nudges). A host that does not have
   *   it is HEALTHY, and the audit must say so instead of reporting a
   *   permanent red.
   *
   * This flag exists because the taxonomy is not a promise about the
   * disk: the chains are created by their first writer, so a fresh
   * install legitimately has fewer directories than the catalog names.
   */
  availability: 'standard' | 'conditional';
}

export const CHAIN_CATALOG = {
  journal: {
    name: 'journal',
    purpose: 'Persistent memory — thoughts, observations, learnings. Semantic-indexed for recall.',
    blockTypes: ['journal', 'insight'],
    writeFrequency: 'high',
    consentDefault: 'local-only',
    searchable: true,
    availability: 'standard',
  },
  decisions: {
    name: 'decisions',
    purpose: 'Recorded choices with context, rationale, correlation IDs.',
    blockTypes: ['decision', 'ask'],
    writeFrequency: 'medium',
    consentDefault: 'exportable',
    searchable: true,
    availability: 'standard',
  },
  reflections: {
    name: 'reflections',
    purpose:
      'Self-assessment — daily/weekly pattern analysis, performance review, alignment checks.',
    blockTypes: ['insight', 'system_event'],
    writeFrequency: 'low',
    consentDefault: 'exportable',
    searchable: true,
    availability: 'standard',
  },
  cases: {
    name: 'cases',
    purpose:
      'Case-based knowledge graph — linguistic-case entries (actor, target, instrument, etc.). Indexed in SQLite (case-index.sqlite) for relational queries.',
    blockTypes: ['case'],
    writeFrequency: 'medium',
    consentDefault: 'local-only',
    searchable: true,
    availability: 'standard',
  },
  patterns: {
    name: 'patterns',
    purpose: 'Learned predictive patterns from Model C (pattern extraction engine).',
    blockTypes: ['insight'],
    writeFrequency: 'low',
    consentDefault: 'exportable',
    searchable: true,
    availability: 'standard',
  },
  autonom_archive: {
    name: 'autonom_archive',
    purpose:
      'Operator-imported archive — autonom.edu.pl/publications (Mazur, Kossecki, Wegrzyn et al. Polska Szkola Cybernetyczna).',
    // `autonom_publication` is NOT a variant of the native core's
    // `BlockType` enum (crates/memphis-core/src/block.rs:5) — measured:
    // the core answers "unknown variant `autonom_publication`" for it.
    // The catalog may not declare a type the core cannot read; the
    // canonical shape is `system_event` with the semantic name in `kind`.
    blockTypes: ['system_event'],
    writeFrequency: 'low',
    consentDefault: 'exportable',
    searchable: true,
    availability: 'standard',
  },
  proposals: {
    name: 'proposals',
    purpose:
      'Dreaming proposals — deterministic findings from the corpus, each carrying evidence and prevalence, waiting for the operator gate.',
    blockTypes: ['system_event'],
    writeFrequency: 'low',
    // Local-only: a proposal carries quotes from the operator's own
    // transcripts (the correction signal quotes user turns), so it is
    // not export material by default.
    consentDefault: 'local-only',
    // Not searchable: a proposal is not knowledge yet. It is a candidate,
    // and `memphis dream list` is where candidates live until the gate
    // accepts one.
    searchable: false,
    availability: 'standard',
  },

  system: {
    name: 'system',
    purpose:
      'Audit trail — every LLM call, tool invocation, boot/shutdown, heartbeat, error. Highest-volume chain.',
    blockTypes: ['system', 'system_event', 'tool_call', 'tool_result', 'error'],
    writeFrequency: 'high',
    consentDefault: 'exportable',
    searchable: false,
    availability: 'standard',
  },
  collective: {
    name: 'collective',
    purpose:
      'Multi-agent coordination artefacts from Model D (consensus, handoffs, cross-agent messages).',
    blockTypes: ['system_event', 'decision'],
    writeFrequency: 'medium',
    consentDefault: 'exportable',
    searchable: true,
    availability: 'standard',
  },
  proactive: {
    name: 'proactive',
    purpose:
      "Memphis-initiated suggestions — including what the runtime itself could change to work better (operator-stated intent, 2026-11-04). Written opportunistically, so the chain's absence is not drift.",
    blockTypes: ['system_event', 'insight'],
    writeFrequency: 'low',
    consentDefault: 'local-only',
    searchable: true,
    availability: 'conditional',
  },
  insights: {
    name: 'insights',
    purpose: 'Generated insights from the insight generator (daily/weekly/topic-scoped analyses).',
    blockTypes: ['insight'],
    writeFrequency: 'low',
    consentDefault: 'exportable',
    searchable: true,
    availability: 'standard',
  },
  soul: {
    name: 'soul',
    purpose:
      'Identity + learned-memory evolution — updates to soul-memory.json are audited here with Genitive/Accusative case entries.',
    blockTypes: ['case', 'system_event'],
    writeFrequency: 'medium',
    consentDefault: 'local-only',
    searchable: false,
    availability: 'standard',
  },
  messages: {
    name: 'messages',
    purpose:
      'MP v0 federation envelope log — every signed inbound/outbound peer-to-peer message. Tamper-evident transcript of what this Memphis sent and received.',
    // The federation feature is off unless MP v0 is enabled, so the chain
    // is absent on most hosts — and `mp_v0.envelope_sent` /
    // `mp_v0.envelope_received` are not variants of the native core's
    // `BlockType` enum either (measured: "unknown variant").
    blockTypes: ['system_event'],
    writeFrequency: 'high',
    consentDefault: 'local-only',
    searchable: false,
    availability: 'conditional',
  },
} as const satisfies Record<string, ChainDefinition>;

export type ChainName = keyof typeof CHAIN_CATALOG;

/** All canonical chain names, ordered for stable docs/tooling output. */
export function getChainNames(): ChainName[] {
  return Object.keys(CHAIN_CATALOG) as ChainName[];
}

/** Chains whose blocks are included in semantic + exact search indexes. */
export function getSearchableChainNames(): ChainName[] {
  return getChainNames().filter((name) => CHAIN_CATALOG[name].searchable);
}

/** Chain definitions whose blocks default to `exportable` consent (training-safe). */
export function getExportableByDefaultChains(): ChainName[] {
  return getChainNames().filter((name) => CHAIN_CATALOG[name].consentDefault === 'exportable');
}

export function getChainDefinition(name: string): ChainDefinition | undefined {
  // Codex follow-up on this PR: use Object.hasOwn to avoid prototype-chain
  // lookups returning inherited members (toString, __proto__, etc.) for
  // operator-supplied strings. A direct index+cast returned those inherited
  // values and would misrepresent non-chain input as a valid ChainDefinition
  // to callers trusting this helper.
  if (!Object.hasOwn(CHAIN_CATALOG, name)) return undefined;
  return (CHAIN_CATALOG as Record<string, ChainDefinition>)[name];
}

/**
 * Type guard for narrowing operator-supplied strings to known chain names.
 * Legacy callers that accept arbitrary chain names should keep doing so
 * (strict mode is separate); this helps consumers that want to discriminate.
 *
 * Uses `Object.hasOwn` rather than `in` so prototype keys (toString,
 * __proto__, etc.) never pass as "known chains" on untrusted input.
 */
export function isKnownChainName(value: string): value is ChainName {
  return Object.hasOwn(CHAIN_CATALOG, value);
}

/**
 * The shape of a chain directory name.
 *
 * This constant lived in five places — `chain-adapter.ts`,
 * `chain-rotation.ts`, `chain-archive-restore.ts`,
 * `migrations/runner.ts` and `http/routes/memory.ts` — each with its own
 * copy of the same regex. Five copies of the rule that decides what
 * Memphis will open is five chances to disagree, and they did: the
 * verifier's copy had no dot in it, so the three archives the operator
 * had explicitly allowlisted could not be opened by it.
 *
 * One definition, imported by every consumer. It lives here, in the
 * registry, because this is the module that owns the answer to "what is
 * a chain".
 */
export const SAFE_CHAIN_NAME = /^[A-Za-z0-9_-]{1,64}$/;

/** Recovery copies use either epoch milliseconds or the legacy ISO filename stamp. */
export function isChainBackupDirectory(name: string): boolean {
  return /^[a-zA-Z0-9_-]+\.backup-(?:\d+|\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z)$/.test(name);
}

/**
 * The logical chain a directory holds.
 *
 * `journal` → `journal`; `journal.backup-1784913076785` → `journal`.
 * The archive suffix is a COPY marker, not part of the chain's identity:
 * the blocks inside it carry `chain: "journal"`, and that is what the
 * hash chain was built over. Reading the directory name as the chain
 * name is how a repair would rewrite every archived block's `chain`
 * field and invalidate the archive's hashes.
 */
export function logicalChainNameForDirectory(name: string): string {
  const match = /^(.+?)\.backup-(?:\d+|\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z)$/.exec(name);
  return match?.[1] ?? name;
}

/** Chains that are expected on a live host. */
export function getStandardChainNames(): ChainName[] {
  return getChainNames().filter((name) => CHAIN_CATALOG[name].availability === 'standard');
}

/**
 * Chains that belong to a feature that may be off, or that are written
 * only opportunistically. Their absence on a host is NOT drift.
 */
export function getConditionalChainNames(): ChainName[] {
  return getChainNames().filter((name) => CHAIN_CATALOG[name].availability === 'conditional');
}
