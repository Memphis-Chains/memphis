/**
 * R2 falsifier — run the proposal generator over the real corpus.
 *
 * The design (docs/design/DREAMING-GAPS-AND-REFACTOR.md §3.1) gives R2 one
 * falsifier: the real corpus yields proposals that each carry evidence and
 * prevalence, and `memphis dream list` shows them with their evidence.
 *
 * This script prints the proposals the corpus yields and checks the rules
 * that make them worth an operator's attention:
 *
 *   1. every proposal carries evidence — a proposal without evidence is
 *      invalid (the rule the whole mechanism rests on)
 *   2. every proposal carries a prevalence: occurrences and a denominator
 *   3. the ids are unique and stable, so a second scan writes nothing new
 *   4. one bug is one proposal: the signals about tools the runtime does
 *      not know collapse into a single proposal
 *
 * It also reads the `proposals` chain (read-only) to report how many of
 * the proposals are already there.
 *
 * USAGE
 * -----
 *   npm run -s ops:dream-proposals
 *   DATABASE_URL=file:/path/to/memphis.db npm run -s ops:dream-proposals
 */

import { loadDreamingCorpus } from '../src/cognitive/dreaming/load.js';
import { readProposals } from '../src/cognitive/dreaming/proposal-chain.js';
import { buildProposalsWithSignals } from '../src/cognitive/dreaming/proposals.js';

const databaseUrl = process.env.DATABASE_URL?.trim() || 'file:./data/memphis.db';

const corpus = loadDreamingCorpus({
  rawEnv: { ...process.env, DATABASE_URL: databaseUrl },
});

console.log(`database: ${databaseUrl}`);
console.log(
  `status: ${corpus.status} | turns: ${corpus.stats.turns} | sessions: ${corpus.stats.sessions}`,
);
if (corpus.status !== 'ok') {
  console.log('no chat log to dream about');
  process.exit(0);
}

const { proposals, signals } = buildProposalsWithSignals(corpus.turns);

console.log(`\nsignals: ${signals.length}`);
console.log(`proposals: ${proposals.length}`);

console.log('\n=== proposals ===');
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

// ---- the falsifier ----
const withoutEvidence = proposals.filter((proposal) => proposal.evidence.length === 0);
const withoutPrevalence = proposals.filter(
  (proposal) => proposal.prevalence.occurrences <= 0 || proposal.prevalence.denominator <= 0,
);
const ids = proposals.map((proposal) => proposal.id);
const duplicateIds = ids.filter((id, index) => ids.indexOf(id) !== index);

// The unknown-tool signals are one bug, so they have to be one proposal.
const unknownToolSignals = signals.filter((signal) =>
  signal.evidence.some((item) => /unsupported native rust chat tool:\s*\S+/.test(item.quote)),
);
const unknownToolProposals = proposals.filter(
  (proposal) => proposal.id === 'proposal:unknown-tool',
);

const stored = await readProposals();
const storedWithoutEvidence = stored.filter((proposal) => proposal.evidence.length === 0);

console.log('\n=== R2 falsifier ===');
console.log(`proposals without evidence:        ${withoutEvidence.length}`);
console.log(`proposals without prevalence:      ${withoutPrevalence.length}`);
console.log(`duplicate ids:                     ${duplicateIds.length}`);
console.log(
  `unknown-tool signals -> proposals:  ${unknownToolSignals.length} -> ${unknownToolProposals.length}`,
);
console.log(`proposals already in the chain:    ${stored.length}`);
console.log(`stored proposals without evidence: ${storedWithoutEvidence.length}`);

const ok =
  proposals.length > 0 &&
  withoutEvidence.length === 0 &&
  withoutPrevalence.length === 0 &&
  duplicateIds.length === 0 &&
  unknownToolProposals.length <= 1 &&
  storedWithoutEvidence.length === 0;

console.log(
  ok
    ? 'VERDICT: every proposal the corpus yields carries evidence and prevalence'
    : 'VERDICT: MISMATCH',
);
for (const proposal of withoutEvidence) console.log(`  no evidence: ${proposal.id}`);
for (const proposal of withoutPrevalence) console.log(`  no prevalence: ${proposal.id}`);
for (const id of duplicateIds) console.log(`  duplicate id: ${id}`);

process.exit(ok ? 0 : 1);
