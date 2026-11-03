/**
 * `memphis dream` — the proposals the corpus yields, and the proposals
 * that are already in the chain.
 *
 * THE THREE COMMANDS, AND WHY THEY ARE THESE THREE
 * -------------------------------------------------
 *   list     what has been proposed. The source is the `proposals` chain,
 *            NOT the live detectors (operator decision, 2026-11-03): the
 *            chain is what the operator acts on, and a list that changed
 *            under the operator's feet would be worthless as a gate.
 *   show     one proposal, with its evidence.
 *   propose  run the deterministic tier over the corpus and write the
 *            proposals that are NOT in the chain yet. It is idempotent:
 *            a proposal id that is already there is not written again.
 *
 * Accepting a proposal is NOT here. That is R3's gate, and it is an
 * operator action on tier 2 (`docs/design/DREAMING.md` §3.5).
 */

import { loadDreamingCorpus } from '../../../cognitive/dreaming/load.js';
import { appendProposal, readProposals } from '../../../cognitive/dreaming/proposal-chain.js';
import type { Proposal } from '../../../cognitive/dreaming/proposal-lifecycle.js';
import { buildProposalsWithSignals } from '../../../cognitive/dreaming/proposals.js';
import type { CliContext } from '../context.js';
import { print } from '../utils/render.js';

const DREAM_SUBCOMMANDS = new Set(['list', 'show', 'propose']);

export async function handleDreamCommand(context: CliContext): Promise<boolean> {
  if (context.args.command !== 'dream') {
    return false;
  }

  const subcommand = context.args.subcommand ?? 'list';
  if (!DREAM_SUBCOMMANDS.has(subcommand)) {
    throw new Error(
      `unknown dream subcommand: ${subcommand} (expected ${[...DREAM_SUBCOMMANDS].join(', ')})`,
    );
  }

  if (subcommand === 'list') {
    return handleDreamList(context);
  }
  if (subcommand === 'show') {
    return handleDreamShow(context);
  }
  return handleDreamPropose(context);
}

async function handleDreamList(context: CliContext): Promise<boolean> {
  const proposals = await readProposals();
  if (context.args.json) {
    print(proposals, true);
    return true;
  }

  if (proposals.length === 0) {
    console.log('no proposals yet — run `memphis dream propose` to scan the corpus');
    return true;
  }

  const pending = proposals.filter((proposal) => proposal.status === 'pending').length;
  console.log(`proposals: ${proposals.length} (${pending} pending)`);
  for (const proposal of proposals) {
    console.log(`\n[${proposal.status}] ${proposal.id}`);
    console.log(
      `  kind: ${proposal.kind} | scope: ${proposal.target.scope} | confidence: ${proposal.confidence}`,
    );
    console.log(
      `  prevalence: ${proposal.prevalence.occurrences} occurrence(s), ${proposal.prevalence.sessions} session(s), denominator ${proposal.prevalence.denominator}`,
    );
    console.log(`  ${proposal.rationale}`);
    for (const item of proposal.evidence.slice(0, 3)) {
      console.log(`    - ${item.sessionId}#${item.sequence} ${item.quote}`);
    }
  }
  return true;
}

async function handleDreamShow(context: CliContext): Promise<boolean> {
  const id = resolveProposalId(context);
  const proposals = await readProposals();
  const proposal = proposals.find((candidate) => candidate.id === id);
  if (!proposal) {
    throw new Error(
      `no proposal with id "${id}" (${proposals.length} proposal(s) in the chain — try \`memphis dream list\`)`,
    );
  }
  printProposal(proposal, context.args.json);
  return true;
}

async function handleDreamPropose(context: CliContext): Promise<boolean> {
  const corpus = loadDreamingCorpus({ rawEnv: process.env });
  if (corpus.status !== 'ok') {
    print({ ok: false, reason: 'no chat log to dream about' }, context.args.json);
    return true;
  }

  const { proposals, signals } = buildProposalsWithSignals(corpus.turns);
  const existing = new Set((await readProposals()).map((proposal) => proposal.id));
  const fresh = proposals.filter((proposal) => !existing.has(proposal.id));

  const written: Array<{ id: string; index: number; hash: string }> = [];
  for (const proposal of fresh) {
    const result = await appendProposal(proposal);
    written.push({ id: proposal.id, index: result.index, hash: result.hash });
  }

  const summary = {
    ok: true,
    signals: signals.length,
    proposals: proposals.length,
    written: written.length,
    alreadyPresent: proposals.length - fresh.length,
    blocks: written,
  };
  if (context.args.json) {
    print(summary, true);
    return true;
  }

  console.log(`signals over the corpus: ${signals.length}`);
  console.log(`proposals: ${proposals.length}`);
  console.log(`newly written: ${summary.written}`);
  console.log(`already in the chain: ${summary.alreadyPresent}`);
  for (const block of written) {
    console.log(`  + ${block.id} (index ${block.index})`);
  }
  return true;
}

function resolveProposalId(context: CliContext): string {
  const explicit = context.args.id?.trim();
  if (explicit) return explicit;
  // The positional id comes after the subcommand. The argv shape differs
  // between the shell entry (node + script + command + subcommand) and the
  // TUI host, so the id is looked up after the tokens that name the
  // command and the subcommand rather than at a fixed offset.
  const argv = context.argv;
  const commandIndex = argv.indexOf('dream');
  const subcommandIndex = commandIndex >= 0 ? argv.indexOf('show', commandIndex + 1) : -1;
  const start = subcommandIndex >= 0 ? subcommandIndex + 1 : commandIndex + 1;
  const positional = argv.slice(start).find((token) => !token.startsWith('--') && token.length > 0);
  if (positional) return positional;
  throw new Error('dream show requires --id <proposal id> or a positional id');
}

function printProposal(proposal: Proposal, asJson: boolean): void {
  if (asJson) {
    print(proposal, true);
    return;
  }
  console.log(`id: ${proposal.id}`);
  console.log(`kind: ${proposal.kind}`);
  console.log(`status: ${proposal.status}`);
  console.log(`scope: ${proposal.target.scope}`);
  console.log(`confidence: ${proposal.confidence}`);
  console.log(`proposer: ${proposal.proposer}`);
  console.log(`created: ${proposal.createdAt}`);
  console.log(`\nrationale: ${proposal.rationale}`);
  console.log(`\npatch: ${JSON.stringify(proposal.patch, null, 2)}`);
  console.log(
    `\nprevalence: ${proposal.prevalence.occurrences} occurrence(s), ${proposal.prevalence.sessions} session(s), ${proposal.prevalence.spanDays} day(s), denominator ${proposal.prevalence.denominator}`,
  );
  console.log(`\nevidence (${proposal.evidence.length}):`);
  for (const item of proposal.evidence) {
    console.log(`  - ${item.sessionId}#${item.sequence} ${item.toolName ?? ''} ${item.quote}`);
  }
  console.log(
    `\nbased on ${proposal.basedOn.sessionIds.length} session(s), ${proposal.basedOn.chainBlockHashes.length} chain block hash(es)`,
  );
}
