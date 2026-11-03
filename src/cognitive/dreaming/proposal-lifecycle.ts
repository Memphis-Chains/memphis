/**
 * The proposal object, and the state machine it moves through.
 *
 * WHY A MODULE OF ITS OWN
 * -----------------------
 * A proposal is a durable object, not a message. It lives in the
 * `proposals` chain, so the hash chain gives it versioning, auditability
 * and rollback-by-supersede for free (`docs/design/DREAMING.md` §3.5).
 * The state machine follows the pattern the repo already has
 * (`src/core/decision-lifecycle.ts`): a map of legal transitions and a
 * throw on anything else. One state machine the operator already knows,
 * not two.
 *
 * THE RULE THAT MATTERS
 * ---------------------
 * A proposal without evidence is invalid. That is what keeps the
 * mechanism from becoming a machine that rewrites memory on a hunch, so
 * it is enforced HERE and not left to the callers: `createProposal`
 * refuses to build a proposal without evidence, and `assertValidProposal`
 * refuses to accept one that arrives from anywhere else.
 *
 * MEASURED ON THE LIVE CORPUS (2026-11-03)
 * -----------------------------------------
 * The D2 detectors produce 26 signals over the live corpus, and every one
 * of them carries evidence and prevalence — 0 signals without either.
 * Merging the signals by root cause gives 21 proposals; see
 * `src/cognitive/dreaming/proposals.ts` for the measurement.
 */

export type ProposalKind = 'memory.add' | 'memory.update' | 'memory.retire' | 'org.directive';

export type ProposalStatus =
  | 'pending'
  | 'accepted'
  | 'rejected'
  | 'applied'
  | 'failed'
  | 'expired'
  | 'superseded';

/** One piece of the transcript where the pattern was seen. */
export interface ProposalEvidence {
  sessionId: string;
  sequence: number;
  quote: string;
  toolName?: string;
}

/** How widespread the pattern is, and against what. */
export interface ProposalPrevalence {
  occurrences: number;
  sessions: number;
  spanDays: number;
  denominator: number;
}

export interface Proposal {
  id: string;
  kind: ProposalKind;
  status: ProposalStatus;
  target: { scope: string; id?: string; field?: string };
  patch: unknown;
  evidence: ProposalEvidence[];
  prevalence: ProposalPrevalence;
  confidence: number;
  rationale: string;
  proposer: 'dreaming' | 'agent' | 'operator';
  /** What this was based on — the versioning principle. */
  basedOn: { sessionIds: string[]; chainBlockHashes: string[] };
  createdAt: string;
  decidedAt?: string;
  appliedAt?: string;
}

/** The legal transitions. Anything else throws. */
const ALLOWED: Record<ProposalStatus, ProposalStatus[]> = {
  pending: ['accepted', 'rejected', 'expired', 'superseded'],
  accepted: ['applied', 'failed', 'superseded'],
  rejected: [],
  applied: [],
  failed: [],
  expired: [],
  superseded: [],
};

/**
 * The statuses a proposal can be in, in the order the gate reads them.
 */
export const PROPOSAL_STATUSES: readonly ProposalStatus[] = [
  'pending',
  'accepted',
  'rejected',
  'applied',
  'failed',
  'expired',
  'superseded',
];

/**
 * Move a proposal to another status.
 *
 * A transition that is not in the map throws, exactly like
 * `transitionDecision` does: the gate is the one thing in this mechanism
 * that must not be approximate.
 */
export function transitionProposal(
  proposal: Proposal,
  to: ProposalStatus,
  nowIso: string = new Date().toISOString(),
): Proposal {
  const allowed = ALLOWED[proposal.status] ?? [];
  if (!allowed.includes(to)) {
    throw new Error(`invalid transition: ${proposal.status} -> ${to}`);
  }
  const next: Proposal = {
    ...proposal,
    status: to,
  };
  if (to === 'accepted' || to === 'rejected') {
    next.decidedAt = nowIso;
  }
  if (to === 'applied') {
    next.appliedAt = nowIso;
  }
  return next;
}

/**
 * The rule the whole mechanism rests on: a proposal without evidence is
 * invalid.
 *
 * It throws instead of returning a flag, because the callers are append
 * paths: a proposal that reaches the chain without evidence has already
 * failed the one test that matters.
 */
export function assertValidProposal(proposal: Proposal): void {
  if (!Array.isArray(proposal.evidence) || proposal.evidence.length === 0) {
    throw new Error(`proposal ${proposal.id} has no evidence`);
  }
  if (proposal.prevalence.occurrences <= 0) {
    throw new Error(`proposal ${proposal.id} has no occurrences`);
  }
  if (proposal.prevalence.denominator <= 0) {
    throw new Error(`proposal ${proposal.id} has no denominator`);
  }
}

/**
 * Build a proposal. Refuses to build one without evidence.
 */
export function createProposal(params: {
  id: string;
  kind: ProposalKind;
  target: { scope: string; id?: string; field?: string };
  patch: unknown;
  evidence: ProposalEvidence[];
  prevalence: ProposalPrevalence;
  confidence: number;
  rationale: string;
  proposer?: Proposal['proposer'];
  basedOn?: { sessionIds: string[]; chainBlockHashes: string[] };
  status?: ProposalStatus;
  nowIso?: string;
}): Proposal {
  const proposal: Proposal = {
    id: params.id,
    kind: params.kind,
    status: params.status ?? 'pending',
    target: params.target,
    patch: params.patch,
    evidence: params.evidence,
    prevalence: params.prevalence,
    confidence: params.confidence,
    rationale: params.rationale,
    proposer: params.proposer ?? 'dreaming',
    basedOn: params.basedOn ?? { sessionIds: [], chainBlockHashes: [] },
    createdAt: params.nowIso ?? new Date().toISOString(),
  };
  assertValidProposal(proposal);
  return proposal;
}
