/** Fail-closed application journal for operator-approved reflection updates. */
import { createHash } from 'node:crypto';

import { openDreamApprovalDatabase, proposalApprovalDigest, validateDreamOperator,
  validateReflectionProposal, verifyDreamApproval } from './operator-approval.js';
import { proposalBlockData, readProposals } from './proposal-chain.js';
import { transitionProposal, type Proposal } from './proposal-lifecycle.js';
import { appendBlockConditional } from '../../infra/storage/chain-adapter.js';
import { applySoulMemoryProposal, inspectSoulMemoryAtomically, rollbackSoulMemoryProposal } from '../../soul/memory.js';

type ApplicationRow = { proposal_id: string; proposal_digest: string; status: string;
  before_json: string; before_hash: string; after_hash: string };

function schema(db: ReturnType<typeof openDreamApprovalDatabase>): void {
  db.exec(`CREATE TABLE IF NOT EXISTS dream_soul_applications (
    proposal_id TEXT PRIMARY KEY, proposal_digest TEXT NOT NULL, status TEXT NOT NULL,
    before_json TEXT NOT NULL, before_hash TEXT NOT NULL, after_hash TEXT NOT NULL, updated_at TEXT NOT NULL
  ); CREATE TABLE IF NOT EXISTS dream_soul_recovery_audit (
    proposal_id TEXT NOT NULL, from_status TEXT NOT NULL, to_status TEXT NOT NULL,
    observed_hash TEXT NOT NULL, actor TEXT NOT NULL, created_at TEXT NOT NULL
  )`);
}

/** Returns metadata only, never the stored memory snapshot. */
export function dreamApplicationStatus(id: string): { status: string; afterHash: string } | null {
  const db = openDreamApprovalDatabase();
  try {
    schema(db);
    const row = db.prepare('SELECT status,after_hash AS afterHash FROM dream_soul_applications WHERE proposal_id=?').get(id) as {status: string; afterHash: string} | undefined;
    return row ?? null;
  } finally { db.close(); }
}

/** An already-approved update can be applied once; ambiguous states require review. */
export async function applyDreamSoulProposal(requested: Proposal): Promise<'applied' | 'already-applied'> {
  const env = { ...process.env };
  const transaction = await appendBlockConditional('proposals', async () => {
  const proposal = (await readProposals(env)).find((candidate) => candidate.id === requested.id);
  if (!proposal || proposalApprovalDigest(proposal) !== proposalApprovalDigest(requested))
    throw new Error('proposal is missing from the chain or its content changed');
  const update = validateReflectionProposal(proposal);
  if (proposal.status !== 'accepted' && proposal.status !== 'applied') throw new Error('proposal must be accepted before application');
  const digest = proposalApprovalDigest(proposal);
  const db = openDreamApprovalDatabase(env);
  let alreadyApplied = false;
  let beforeHash = '';
  let afterHash = '';
  try {
    schema(db);
    if (!verifyDreamApproval(db, proposal)) throw new Error('no valid operator signature for this proposal');
    const existing = db.prepare('SELECT status,proposal_digest,before_hash,after_hash FROM dream_soul_applications WHERE proposal_id=?').get(proposal.id) as {status: string; proposal_digest: string; before_hash: string; after_hash: string} | undefined;
    if (existing && existing.status !== 'not-applied') {
      if (existing.proposal_digest !== digest || existing.status !== 'applied')
        throw new Error('proposal application is ambiguous or already rolled back; operator review required');
      alreadyApplied = true;
      beforeHash = existing.before_hash;
      afterHash = existing.after_hash;
    } else {
      if (proposal.status !== 'accepted' || (existing && existing.proposal_digest !== digest))
        throw new Error('applied chain state has no matching application journal');
      applySoulMemoryProposal(update, {
        stage(beforeJson, afterJson) {
          if (Buffer.byteLength(beforeJson) > 4 * 1024 * 1024 || Buffer.byteLength(afterJson) > 4 * 1024 * 1024)
            throw new Error('soul memory snapshot exceeds proposal journal limit');
          beforeHash = createHash('sha256').update(beforeJson).digest('hex');
          afterHash = createHash('sha256').update(afterJson).digest('hex');
          db.transaction(() => {
            if (!verifyDreamApproval(db, proposal)) throw new Error('operator approval changed before application');
            if (existing) {
              const changed = db.prepare("UPDATE dream_soul_applications SET status='staged',before_json=?,before_hash=?,after_hash=?,updated_at=? WHERE proposal_id=? AND proposal_digest=? AND status='not-applied'")
                .run(beforeJson, beforeHash, afterHash, new Date().toISOString(), proposal.id, digest);
              if (changed.changes !== 1) throw new Error('proposal application changed concurrently');
            } else {
              db.prepare("INSERT INTO dream_soul_applications VALUES(?,?,'staged',?,?,?,?)")
                .run(proposal.id, digest, beforeJson, beforeHash, afterHash, new Date().toISOString());
            }
          }).immediate();
        },
        complete() {
          const changed = db.prepare("UPDATE dream_soul_applications SET status='applied',updated_at=? WHERE proposal_id=? AND status='staged'")
            .run(new Date().toISOString(), proposal.id);
          if (changed.changes !== 1) throw new Error('proposal application journal could not be finalized');
        },
      }, env);
    }
  } finally { db.close(); }
  return { data: proposal.status === 'accepted' ? proposalBlockData(transitionProposal(proposal, 'applied')) : undefined,
    value: { proposal, digest, alreadyApplied, beforeHash, afterHash } };
  }, env);
  const { proposal, digest, alreadyApplied, beforeHash, afterHash } = transaction.value;
  // The file and chain are separate stores. If this append fails, the next
  // call sees the applied journal and repairs the chain without reapplying.
  await appendBlockConditional('proposals', async () => ({ data: { type: 'system_event', kind: 'dreaming.application',
    content: JSON.stringify({ proposalId: proposal.id, proposalDigest: digest, beforeHash, afterHash,
      status: alreadyApplied ? 'already-applied' : 'applied' }), tags: ['dreaming', 'application'] }, value: undefined }), env);
  return alreadyApplied ? 'already-applied' : 'applied';
}

/** Operator reconciles a staged crash only when the actual file matches a recorded image. */
export async function reconcileDreamSoulProposal(requested: Proposal, operatorPassphrase: string,
  tier2Passphrase: string): Promise<string> {
  validateDreamOperator(operatorPassphrase, tier2Passphrase);
  const env = { ...process.env };
  const proposal = (await readProposals(env)).find((candidate) => candidate.id === requested.id);
  if (!proposal || proposalApprovalDigest(proposal) !== proposalApprovalDigest(requested))
    throw new Error('proposal is missing from the chain or its content changed');
  const db = openDreamApprovalDatabase(env);
  try {
    schema(db);
    if (!verifyDreamApproval(db, proposal)) throw new Error('no valid operator signature for this proposal');
    return inspectSoulMemoryAtomically((json) => db.transaction(() => {
      const row = db.prepare('SELECT proposal_id,proposal_digest,status,before_json,before_hash,after_hash FROM dream_soul_applications WHERE proposal_id=?')
        .get(proposal.id) as ApplicationRow | undefined;
      if (!row || row.proposal_digest !== proposalApprovalDigest(proposal) || !['staged','rollback-staged'].includes(row.status))
        throw new Error('no matching staged application to reconcile');
      if (createHash('sha256').update(row.before_json).digest('hex') !== row.before_hash)
        throw new Error('stored rollback snapshot failed its integrity check');
      const observed = createHash('sha256').update(json).digest('hex');
      const next = row.status === 'staged'
        ? observed === row.before_hash ? 'not-applied' : observed === row.after_hash ? 'applied' : null
        : observed === row.after_hash ? 'applied' : observed === row.before_hash ? 'rolled-back' : null;
      if (!next) throw new Error('current soul memory matches neither recorded image; manual investigation required');
      const at = new Date().toISOString();
      const changed = db.prepare('UPDATE dream_soul_applications SET status=?,updated_at=? WHERE proposal_id=? AND status=?')
        .run(next, at, proposal.id, row.status);
      if (changed.changes !== 1) throw new Error('application changed concurrently');
      db.prepare('INSERT INTO dream_soul_recovery_audit VALUES(?,?,?,?,?,?)')
        .run(proposal.id, row.status, next, observed, 'local-operator', at);
      return next;
    }).immediate(), env);
  } finally { db.close(); }
}

/** A rollback restores only an unchanged post-application image. */
export async function rollbackDreamSoulProposal(requested: Proposal, operatorPassphrase: string,
  tier2Passphrase: string): Promise<'rolled-back' | 'already-rolled-back'> {
  validateDreamOperator(operatorPassphrase, tier2Passphrase);
  const env = { ...process.env };
  const proposal = (await readProposals(env)).find((candidate) => candidate.id === requested.id);
  if (!proposal || proposalApprovalDigest(proposal) !== proposalApprovalDigest(requested))
    throw new Error('proposal is missing from the chain or its content changed');
  validateReflectionProposal(proposal);
  const db = openDreamApprovalDatabase(env);
  let alreadyRolledBack = false;
  let afterHash = '';
  try {
    schema(db);
    if (!verifyDreamApproval(db, proposal)) throw new Error('no valid operator signature for this proposal');
    const row = db.prepare('SELECT proposal_id,proposal_digest,status,before_json,before_hash,after_hash FROM dream_soul_applications WHERE proposal_id=?')
      .get(proposal.id) as ApplicationRow | undefined;
    if (!row || row.proposal_digest !== proposalApprovalDigest(proposal)) throw new Error('matching applied proposal not found');
    if (createHash('sha256').update(row.before_json).digest('hex') !== row.before_hash)
      throw new Error('stored rollback snapshot failed its integrity check');
    afterHash = row.after_hash;
    if (row.status === 'rolled-back') alreadyRolledBack = true;
    else if (row.status !== 'applied') throw new Error('application or rollback is ambiguous; operator review required');
    else rollbackSoulMemoryProposal(row.after_hash, row.before_json, {
      stage() {
        const changed = db.prepare("UPDATE dream_soul_applications SET status='rollback-staged',updated_at=? WHERE proposal_id=? AND status='applied'")
          .run(new Date().toISOString(), proposal.id);
        if (changed.changes !== 1) throw new Error('rollback was concurrently changed');
      },
      complete() {
        const changed = db.prepare("UPDATE dream_soul_applications SET status='rolled-back',updated_at=? WHERE proposal_id=? AND status='rollback-staged'")
          .run(new Date().toISOString(), proposal.id);
        if (changed.changes !== 1) throw new Error('rollback journal could not be finalized');
      },
    }, env);
  } finally { db.close(); }
  await appendBlockConditional('proposals', async () => ({ data: { type: 'system_event', kind: 'dreaming.rollback',
    content: JSON.stringify({ proposalId: proposal.id, proposalDigest: proposalApprovalDigest(proposal), afterHash,
      actor: 'local-operator', status: alreadyRolledBack ? 'already-rolled-back' : 'rolled-back' }), tags: ['dreaming', 'rollback'] }, value: undefined }), env);
  return alreadyRolledBack ? 'already-rolled-back' : 'rolled-back';
}
