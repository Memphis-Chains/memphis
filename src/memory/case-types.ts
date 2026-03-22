/**
 * TypeScript types mirroring Rust CaseEntry/CaseType/CaseQuery.
 * These correspond to the 8 Polish grammatical cases used as
 * semantic roles in the cognitive knowledge graph.
 */

export type CaseType =
  | 'nominative'
  | 'genitive'
  | 'dative'
  | 'accusative'
  | 'instrumental'
  | 'locative'
  | 'ablative'
  | 'vocative';

export type CaseEntry =
  | { case_type: 'nominative'; entity: string; action: string; timestamp: string }
  | { case_type: 'genitive'; owner: string; possessed: string }
  | { case_type: 'dative'; giver: string; recipient: string; object: string }
  | { case_type: 'accusative'; subject: string; verb: string; object: string }
  | { case_type: 'instrumental'; actor: string; instrument: string; target: string }
  | { case_type: 'locative'; entity: string; location: string }
  | { case_type: 'ablative'; entity: string; origin: string; destination?: string }
  | { case_type: 'vocative'; invoker: string; invocation: string; target: string };

export interface CaseQuery {
  case_type?: CaseType;
  entity?: string;
  actor?: string;
  target?: string;
  instrument?: string;
  location?: string;
  limit?: number;
}

export interface CaseIndexRow {
  block_index: number;
  block_hash: string;
  chain: string;
  case_type: CaseType;
  entity?: string;
  actor?: string;
  target?: string;
  instrument?: string;
  location?: string;
  origin?: string;
  destination?: string;
  owner?: string;
  possessed?: string;
  giver?: string;
  recipient?: string;
  object?: string;
  subject?: string;
  verb?: string;
  invoker?: string;
  invocation?: string;
  entry_timestamp?: string;
  indexed_at: string;
  full_json: string;
}

export interface CaseAppendResult {
  success: boolean;
  index: number;
  hash: string;
  chain: string;
  timestamp: string;
  case_type: CaseType;
}

export interface CaseQueryResult {
  count: number;
  entries: CaseIndexRow[];
}

export interface CaseRebuildReport {
  indexed: number;
  errors: number;
}
