/**
 * The case domain model — the eight Polish grammatical cases used as
 * semantic roles in the cognitive knowledge graph.
 *
 * WHAT LEFT THIS FILE (2026-11-24)
 * ---------------------------------
 * `CaseIndexRow` used to live here, with TWENTY-FOUR fields:
 * `entity`, `actor`, `target`, `instrument`, `location`, `origin`,
 * `destination`, `owner`, `possessed`, `giver`, `recipient`, `object`,
 * `subject`, `verb`, `invoker`, `invocation`, `entry_timestamp`,
 * `indexed_at` and more besides.
 *
 * MEASURED on the built bridge: the wire sends SIX keys — `block_index`,
 * `block_hash`, `chain`, `case_type`, `full_json` and `entry` — and the
 * one that carries the case itself (`entry`) was MISSING from the
 * hand-written type. The two query paths (Rust and TypeScript) therefore
 * answered with two different shapes, and `memphis case explain` read
 * `entry.entity` and `entry_timestamp`, which on the Rust path never
 * arrive.
 *
 * The row on the wire now belongs to the OWNER: `CaseIndexRowPayload`,
 * projected into `src/infra/storage/bridge-payloads.generated.ts`. The
 * query's answer is `CaseQueryPayload` and the rebuild's answer is
 * `CaseRebuildPayload` — both from the same owner.
 *
 * WHAT STAYS, AND WHY
 * -------------------
 * `CaseEntry` is the DOMAIN model: eight variants, each with its own
 * fields, so an invalid combination (a genitive with a `verb`) cannot be
 * written down. The owner's shape is deliberately LOOSER — the tag plus
 * the union of the variants' fields — because that is what the wire
 * carries. The two agree, and the per-variant shapes are the explicit
 * residue of E-09 (see the ledger).
 *
 * `CaseQuery` is an INPUT, not a payload: it is what the TypeScript side
 * SENDS. Its fields match the Rust `CaseQuery` struct one for one
 * (`case_type`, `entity`, `actor`, `target`, `instrument`, `location`,
 * `limit`), checked by reading both sources on 2026-11-24. It is not
 * gated by the payload contract, because the payload contract owns what
 * the bridge RETURNS.
 */

/**
 * The legal case types, as a runtime value.
 *
 * The list used to exist only as a TypeScript union, which meant every
 * place that needed it at runtime — a Zod enum for a tool schema — had to
 * spell the eight names out again. Measured on this host: four copies
 * (this file's union, `tool-registry/storage.ts` twice, and the MCP
 * server). One list, and the type is derived from it.
 */
export const CASE_TYPES = [
  'nominative',
  'genitive',
  'dative',
  'accusative',
  'instrumental',
  'locative',
  'ablative',
  'vocative',
] as const;

export type CaseType = (typeof CASE_TYPES)[number];

/**
 * One case entry — the domain model.
 *
 * The Rust core spells the same eight cases as an enum tagged with
 * `case_type` (`#[serde(tag = "case_type", rename_all = "snake_case")]`),
 * so the wire carries the tag plus the fields OF THAT CASE. This union is
 * the stricter half of the same contract: it says which fields belong to
 * which case, so a genitive cannot carry a `verb`.
 */
export type CaseEntry =
  | { case_type: 'nominative'; entity: string; action: string; timestamp: string }
  | { case_type: 'genitive'; owner: string; possessed: string }
  | { case_type: 'dative'; giver: string; recipient: string; object: string }
  | { case_type: 'accusative'; subject: string; verb: string; object: string }
  | { case_type: 'instrumental'; actor: string; instrument: string; target: string }
  | { case_type: 'locative'; entity: string; location: string }
  | { case_type: 'ablative'; entity: string; origin: string; destination?: string }
  | { case_type: 'vocative'; invoker: string; invocation: string; target: string };

/**
 * The filter `case_query` accepts — an INPUT, sent to the bridge.
 *
 * The Rust struct is `memphis_core::case_entry::CaseQuery`, and the
 * bridge's SQLite index filters on the DENORMALIZED columns
 * (`entity`, `actor`, `target`, `instrument`, `location`) — which the
 * index fills from the entry's accessors.
 */
export interface CaseQuery {
  case_type?: CaseType;
  entity?: string;
  actor?: string;
  target?: string;
  instrument?: string;
  location?: string;
  limit?: number;
}

/**
 * What an append answers — the ADAPTER's result, not a wire payload.
 *
 * The bridge's own answer (`CaseAppendPayload`) carries the block it
 * wrote; this is the smaller thing the callers of the adapter want.
 */
export interface CaseAppendResult {
  success: boolean;
  index: number;
  hash: string;
  chain: string;
  timestamp: string;
  case_type: CaseType;
}
