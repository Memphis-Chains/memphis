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
}

export const CHAIN_CATALOG = {
  journal: {
    name: 'journal',
    purpose:
      'Persistent memory — thoughts, observations, learnings. Semantic-indexed for recall.',
    blockTypes: ['journal', 'insight'],
    writeFrequency: 'high',
    consentDefault: 'local-only',
    searchable: true,
  },
  decisions: {
    name: 'decisions',
    purpose: 'Recorded choices with context, rationale, correlation IDs.',
    blockTypes: ['decision', 'ask'],
    writeFrequency: 'medium',
    consentDefault: 'exportable',
    searchable: true,
  },
  reflections: {
    name: 'reflections',
    purpose:
      'Self-assessment — daily/weekly pattern analysis, performance review, alignment checks.',
    blockTypes: ['insight', 'system_event'],
    writeFrequency: 'low',
    consentDefault: 'exportable',
    searchable: true,
  },
  cases: {
    name: 'cases',
    purpose:
      'Case-based knowledge graph — linguistic-case entries (actor, target, instrument, etc.). Indexed in SQLite (case-index.sqlite) for relational queries.',
    blockTypes: ['case'],
    writeFrequency: 'medium',
    consentDefault: 'local-only',
    searchable: true,
  },
  patterns: {
    name: 'patterns',
    purpose: 'Learned predictive patterns from Model C (pattern extraction engine).',
    blockTypes: ['insight'],
    writeFrequency: 'low',
    consentDefault: 'exportable',
    searchable: true,
  },
  system: {
    name: 'system',
    purpose:
      'Audit trail — every LLM call, tool invocation, boot/shutdown, heartbeat, error. Highest-volume chain.',
    blockTypes: ['system', 'system_event', 'tool_call', 'tool_result', 'error'],
    writeFrequency: 'high',
    consentDefault: 'exportable',
    searchable: false,
  },
  collective: {
    name: 'collective',
    purpose:
      'Multi-agent coordination artefacts from Model D (consensus, handoffs, cross-agent messages).',
    blockTypes: ['system_event', 'decision'],
    writeFrequency: 'medium',
    consentDefault: 'exportable',
    searchable: true,
  },
  proactive: {
    name: 'proactive',
    purpose:
      'Proactive-assistant suggestions — Memphis-initiated nudges the operator may act on or dismiss.',
    blockTypes: ['system_event', 'insight'],
    writeFrequency: 'low',
    consentDefault: 'local-only',
    searchable: true,
  },
  insights: {
    name: 'insights',
    purpose:
      'Generated insights from the insight generator (daily/weekly/topic-scoped analyses).',
    blockTypes: ['insight'],
    writeFrequency: 'low',
    consentDefault: 'exportable',
    searchable: true,
  },
  soul: {
    name: 'soul',
    purpose:
      'Identity + learned-memory evolution — updates to soul-memory.json are audited here with Genitive/Accusative case entries.',
    blockTypes: ['case', 'system_event'],
    writeFrequency: 'medium',
    consentDefault: 'local-only',
    searchable: false,
  },
  messages: {
    name: 'messages',
    purpose:
      'MP v0 federation envelope log — every signed inbound/outbound peer-to-peer message. Tamper-evident transcript of what this Memphis sent and received.',
    blockTypes: ['mp_v0.envelope_sent', 'mp_v0.envelope_received'],
    writeFrequency: 'high',
    consentDefault: 'local-only',
    searchable: false,
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
  return getChainNames().filter(
    (name) => CHAIN_CATALOG[name].consentDefault === 'exportable',
  );
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
