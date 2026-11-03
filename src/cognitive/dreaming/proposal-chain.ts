/**
 * The `proposals` chain: writing a proposal, reading it back.
 *
 * THE BLOCK SHAPE, AND WHY IT IS THIS SHAPE
 * ------------------------------------------
 * Measured on this host (2026-11-03), the Rust core accepts a block whose
 * `data.type` is `system_event` with `data.kind = "dreaming.proposal"`,
 * and rejects an unknown variant outright:
 *
 *   chain_validate(<block with type proposal>)
 *     → invalid_block_json: unknown variant `proposal`
 *   chain_validate(<block with type system_event>)
 *     → parses
 *
 * `system_event` is also the repo's own convention for a new kind of
 * write (`crates/memphis-core/src/block.rs:19`): the semantic name goes
 * in `kind`, not in a new variant of a closed enum.
 *
 * The payload lives in `content`, and that is not cosmetic. The block hash
 * covers `type`, `content` and `tags` only (`compute_hash`,
 * `crates/memphis-core/src/hash.rs:5`; `toCanonicalHashData`,
 * `src/infra/storage/rust-chain-adapter.ts:181`). A payload in sibling
 * fields would sit OUTSIDE the hash: change the evidence and the chain
 * would still verify. `normalizeData`
 * (`src/infra/storage/rust-chain-adapter.ts:160`) does the right thing on
 * its own — with no `content` string passed it sets
 * `content = JSON.stringify(data)` — so the whole proposal is hash-covered.
 *
 * The chain is append-only, so a status change is a NEW block that
 * supersedes the previous one. The current state of a proposal is the
 * last block that mentions it.
 */

import { join } from 'node:path';

import { transitionProposal, type Proposal, type ProposalStatus } from './proposal-lifecycle.js';
import { getReadableChainPaths } from '../../config/paths.js';
import { appendBlock, type AppendBlockResult } from '../../infra/storage/chain-adapter.js';
import { listBlockFiles, readBlockFile } from '../../infra/storage/chain-file-io.js';

export const PROPOSALS_CHAIN = 'proposals';
export const PROPOSAL_BLOCK_TYPE = 'system_event';
export const PROPOSAL_BLOCK_KIND = 'dreaming.proposal';

interface ProposalBlock {
  index: number;
  hash: string;
  timestamp: string;
  data?: {
    type?: string;
    kind?: string;
    content?: string;
    tags?: string[];
  };
}

/** One proposal block, with the proposal it carries. */
export interface ProposalRecord {
  block: ProposalBlock;
  proposal: Proposal;
}

function parseProposal(block: ProposalBlock): Proposal | null {
  const data = block.data;
  if (!data || typeof data.content !== 'string') return null;
  if (data.kind !== PROPOSAL_BLOCK_KIND) return null;
  try {
    const parsed: unknown = JSON.parse(data.content);
    if (!parsed || typeof parsed !== 'object') return null;
    const candidate = parsed as Proposal;
    if (typeof candidate.id !== 'string' || typeof candidate.status !== 'string') return null;
    return candidate;
  } catch {
    return null;
  }
}

/**
 * Every proposal block in the chain, in index order.
 */
export async function readProposalBlocks(
  rawEnv: NodeJS.ProcessEnv = process.env,
): Promise<ProposalRecord[]> {
  const records: ProposalRecord[] = [];
  const seen = new Set<string>();

  for (const dir of getReadableChainPaths(PROPOSALS_CHAIN, rawEnv)) {
    let files: string[];
    try {
      files = await listBlockFiles(dir);
    } catch {
      continue;
    }
    for (const file of files) {
      const block = await readBlockFile<ProposalBlock>(join(dir, file));
      const key = `${block.hash}:${block.index}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const proposal = parseProposal(block);
      if (!proposal) continue;
      records.push({ block, proposal });
    }
  }

  return records.sort((a, b) => a.block.index - b.block.index);
}

/**
 * The current state of every proposal: the last block that mentions it
 * wins, because the chain is append-only and a status change is a new
 * block that supersedes the old one.
 */
export async function readProposals(rawEnv: NodeJS.ProcessEnv = process.env): Promise<Proposal[]> {
  const records = await readProposalBlocks(rawEnv);
  const latest = new Map<string, Proposal>();
  for (const record of records) {
    latest.set(record.proposal.id, record.proposal);
  }
  return [...latest.values()].sort(
    (a, b) => b.prevalence.occurrences - a.prevalence.occurrences || a.id.localeCompare(b.id),
  );
}

/**
 * Write a proposal to the chain.
 */
export async function appendProposal(
  proposal: Proposal,
  rawEnv: NodeJS.ProcessEnv = process.env,
): Promise<AppendBlockResult> {
  return appendBlock(
    PROPOSALS_CHAIN,
    {
      type: PROPOSAL_BLOCK_TYPE,
      kind: PROPOSAL_BLOCK_KIND,
      content: JSON.stringify(proposal),
      tags: ['dreaming', 'proposal'],
    },
    rawEnv,
  );
}

/**
 * Move a stored proposal to another status, by appending the new state.
 *
 * The old block stays where it is: that is what the hash chain is for.
 */
export async function transitionStoredProposal(
  proposal: Proposal,
  to: ProposalStatus,
  rawEnv: NodeJS.ProcessEnv = process.env,
): Promise<Proposal> {
  const next = transitionProposal(proposal, to);
  await appendProposal(next, rawEnv);
  return next;
}
