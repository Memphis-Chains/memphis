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
 * written down. It is now the OWNER'S per-variant shape, projected —
 * `CaseEntryPayload` in `src/infra/storage/bridge-payloads.generated.ts`
 * is a DISCRIMINATED UNION, one arm per case, and the two names below
 * are that union.
 *
 * MEASURED 2026-11-24: the union used to be written down HERE, by hand,
 * and NOTHING compared it with the owner — so it could drift while every
 * gate stayed green. The falsifier: the owner grew a field on
 * `CaseEntry::Dative`, the owner's table and the generated mirror grew
 * it with it, the payload contract gate was green (13/13), `tsc` was
 * clean and the TypeScript suite was green — and the hand-written union
 * still did not have the field.
 *
 * `CaseQuery` is an INPUT, not a payload: it is what the TypeScript side
 * SENDS. Its fields match the Rust `CaseQuery` struct one for one
 * (`case_type`, `entity`, `actor`, `target`, `instrument`, `location`,
 * `limit`), checked by reading both sources on 2026-11-24. It is not
 * gated by the payload contract, because the payload contract owns what
 * the bridge RETURNS.
 */

import type { CaseEntryPayload } from '../infra/storage/bridge-payloads.generated.js';

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
 * One case entry — the domain model, and the OWNER's per-variant shape.
 *
 * The Rust core spells the same eight cases as an enum tagged with
 * `case_type` (`#[serde(tag = "case_type", rename_all = "snake_case")]`),
 * so the wire carries the tag plus the fields OF THAT CASE: a nominative
 * entry carries `entity`, `action` and `timestamp`, a genitive one
 * `owner` and `possessed` — and NOT the other's fields.
 *
 * MEASURED 2026-11-24 on this host, over the four case types the corpus
 * holds:
 *
 * | case | the keys the wire carries |
 * | --- | --- |
 * | `accusative` | `case_type`, `subject`, `verb`, `object` |
 * | `genitive` | `case_type`, `owner`, `possessed` |
 * | `instrumental` | `case_type`, `actor`, `instrument`, `target` |
 * | `nominative` | `case_type`, `entity`, `action`, `timestamp` |
 *
 * So `entity` and `timestamp` belong to the NOMINATIVE alone — which is
 * why `memphis explain` used to print an empty entity and a `?` for
 * every row of every other case: it read fields that only one case has.
 *
 * This is the owner's shape, PROJECTED — the union is generated into
 * `src/infra/storage/bridge-payloads.generated.ts` from the Rust table,
 * and the gate checks that table against the enum it describes, variant
 * by variant. The union here is that projection under a name the domain
 * model uses; it is not a second hand-written copy.
 */
export type CaseEntry = CaseEntryPayload;

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
