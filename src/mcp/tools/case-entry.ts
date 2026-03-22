import { CaseChainAdapter } from '../../infra/storage/case-chain-adapter.js';
import type {
  CaseAppendResult,
  CaseEntry,
  CaseQuery,
  CaseQueryResult,
} from '../../memory/case-types.js';

export type MemphisCaseAppendInput = {
  entry: CaseEntry;
};

export type MemphisCaseQueryInput = {
  query: CaseQuery;
};

export type CaseAppendDeps = {
  adapter: CaseChainAdapter;
};

export type CaseQueryDeps = {
  adapter: CaseChainAdapter;
};

const defaultAdapter = new CaseChainAdapter();
const defaultAppendDeps: CaseAppendDeps = { adapter: defaultAdapter };
const defaultQueryDeps: CaseQueryDeps = { adapter: defaultAdapter };

export async function runMemphisCaseAppend(
  input: MemphisCaseAppendInput,
  deps: CaseAppendDeps = defaultAppendDeps,
): Promise<CaseAppendResult> {
  return deps.adapter.appendCaseEntry(input.entry);
}

export async function runMemphisCaseQuery(
  input: MemphisCaseQueryInput,
  deps: CaseQueryDeps = defaultQueryDeps,
): Promise<CaseQueryResult> {
  return deps.adapter.queryCases(input.query);
}
