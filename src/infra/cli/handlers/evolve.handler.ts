import { realpathSync } from 'node:fs';

import type { CommandHandler } from './command-handler.js';
import { promptOperatorPassphrase } from './recovery.handler.js';
import { RollbackManager } from '../../../backup/rollback.js';
import { getDataDir } from '../../../config/paths.js';
import { runMemphisSelfGovernanceStatus } from '../../../mcp/tools/self-governance-status.js';
import { runMemphisSelfModify } from '../../../mcp/tools/self-modify.js';
import { advanceStep } from '../../../modules/self-coding/plan-store.js';
import { loadSoulManifest } from '../../../soul/manifest.js';
import { validateOperatorPassphrase , requireOperatorAuth } from '../../auth/operator-gate.js';
import { usesOperatorForTier2, validateTier2Passphrase } from '../../auth/tier2-auth.js';
import { evolveRequestDigest, validateEvolveRequest, type EvolveRequestPayload } from '../../runtime/evolve-request.js';
import { inspectEvolveReview, mergeEvolveReview, reconcileEvolveReview } from '../../runtime/evolve-review.js';
import { resolveInstallRoot } from '../../runtime/install-root.js';
import { CaseChainAdapter } from '../../storage/case-chain-adapter.js';
import type { SqliteEvolveSessionRepository } from '../../storage/sqlite/repositories/evolve-session-repository.js';
import type { CliContext } from '../context.js';

async function authenticateEvolution(): Promise<string> {
  const operator = await promptOperatorPassphrase('Operator passphrase: ');
  if (!validateOperatorPassphrase(operator)) throw new Error('operator authentication failed');
  const manifest = loadSoulManifest();
  const tier2 = usesOperatorForTier2(manifest) ? operator : await promptOperatorPassphrase('Tier 2 passphrase: ');
  if (validateTier2Passphrase(tier2, manifest) !== 'ok')
    throw new Error('Tier 2 authentication failed');
  return tier2;
}

async function handleEvolveRequest(context: CliContext, action: 'requests' | 'request' | 'prepare'): Promise<boolean> {
  const repo = context.getContainer().evolveSessionRepository;
  const store = repo.requestStore();
  if (action === 'requests') { console.log(JSON.stringify(store.list(), null, 2)); return true; }
  const id = context.args.target;
  if (!id || !/^[a-f0-9]{32}$/.test(id)) throw new Error(`evolve ${action} requires the full request ID`);
  const request = store.get(id);
  if (!request) throw new Error('evolution request not found');
  if (request.root !== realpathSync(resolveInstallRoot()) || evolveRequestDigest(request.payload) !== request.digest)
    throw new Error('request integrity or repository does not match');
  const payload = JSON.parse(request.payload) as EvolveRequestPayload;
  validateEvolveRequest(payload);
  const display = `Request: ${id}\nRepository: ${request.root}\nDigest: ${request.digest}\nStatus: ${request.status}\n${JSON.stringify(payload, null, 2)}`;
  // eslint-disable-next-line no-control-regex -- terminal escape bytes must be rendered inert
  console.log(display.replace(/[\x00-\x08\x0b-\x1f\x7f]/g, (c) => `\\x${c.charCodeAt(0).toString(16).padStart(2, '0')}`));
  if (action === 'request') return true;
  if (request.status !== 'pending' || request.expiresAtMs <= Date.now()) throw new Error('request is not pending or has expired');
  const confirmation = await promptOperatorPassphrase('Type the full request digest shown above: ');
  if (confirmation !== request.digest) throw new Error('request confirmation did not match');
  const passphrase = await authenticateEvolution();
  store.claim(id, request.digest, request.payload, request.root);
  // An interrupted process leaves 'preparing' for inspection; never replay it automatically.
  let result: Awaited<ReturnType<typeof runMemphisSelfModify>>;
  try {
    result = await runMemphisSelfModify({ ...payload, passphrase }, {
      sessionRepo: repo, rollback: new RollbackManager(getDataDir()),
      caseAdapter: new CaseChainAdapter(), projectRoot: request.root,
    });
  } catch (error) {
    store.finish(id, request.digest, false);
    throw error;
  }
  store.finish(id, request.digest, result.success && result.status === 'prepared', result.sessionId);
  console.log(JSON.stringify({ requestId: id, ...result }, null, 2));
  return true;
}

async function annotateSnapshotState<T extends { snapshotId: string | null }>(
  sessions: T[],
): Promise<Array<T & { snapshotState: 'available' | 'missing' | 'n/a' }>> {
  const { RollbackManager } = await import('../../../backup/rollback.js');
  const { getDataDir } = await import('../../../config/paths.js');
  const rollbackMgr = new RollbackManager(getDataDir());
  const snapshots = await rollbackMgr.listSnapshots().catch(() => []);
  const availableIds = new Set(snapshots.map((snapshot) => snapshot.id));

  return sessions.map((session) => ({
    ...session,
    snapshotState: session.snapshotId
      ? availableIds.has(session.snapshotId)
        ? 'available'
        : 'missing'
      : 'n/a',
  }));
}

async function handleEvolveStatus(context: CliContext): Promise<boolean> {
  const repo = context.getContainer().evolveSessionRepository;
  const sessions = (await annotateSnapshotState(repo.listRecent(20))).map((session) => ({
    ...session, reviewStatus: typeof repo.reviewStore === 'function' ? repo.reviewStore().get(session.id)?.status : undefined,
  }));

  if (context.args.json) {
    console.log(JSON.stringify(sessions, null, 2));
    return true;
  }

  if (sessions.length === 0) {
    console.log('No evolution sessions found.');
    return true;
  }

  console.log('Evolution Sessions:');
  console.log('─'.repeat(80));
  for (const s of sessions) {
    const icon =
      s.status === 'committed'
        ? '✓'
        : s.status === 'rolled-back'
          ? '✗'
          : s.status === 'active'
            ? '◉'
            : '○';
    const hash = s.committedHash ? ` [${s.committedHash.slice(0, 8)}]` : '';
    console.log(
      `  ${icon} ${s.id.slice(0, 8)}  ${(s.reviewStatus ?? s.status).padEnd(12)} ${s.intent.slice(0, 50)}${hash}`,
    );
    console.log(
      `    created: ${s.createdAt}  branch: ${s.branch ?? '—'}  snapshot: ${s.snapshotState}`,
    );
    if (s.errorMessage) {
      console.log(`    error: ${s.errorMessage.slice(0, 80)}`);
    }
  }
  console.log('─'.repeat(80));
  console.log(`${String(sessions.length)} session(s)`);
  return true;
}

async function handleEvolveReview(context: CliContext, action: 'review' | 'approve' | 'reconcile' | 'reject'): Promise<boolean> {
  const id = context.args.target;
  if (!id || !/^[0-9a-f-]{36}$/i.test(id)) throw new Error(`evolve ${action} requires the full session ID`);
  const repo = context.getContainer().evolveSessionRepository;
  const store = repo.reviewStore();
  const review = store.get(id);
  if (!review) throw new Error('evolution review not found');
  const session = repo.getById(id);
  if (!session) throw new Error('evolution session not found');
  // eslint-disable-next-line no-control-regex -- terminal escape bytes must be rendered inert
  const safe = (text: string) => text.replace(/[\x00-\x08\x0b-\x1f\x7f]/g, (c) => `\\x${c.charCodeAt(0).toString(16).padStart(2, '0')}`);
  const root = realpathSync(resolveInstallRoot());
  if (review.root !== root) throw new Error('review belongs to a different repository');
  if (action !== 'reconcile') {
    const diff = await inspectEvolveReview(review, root);
    // A code diff can contain terminal control bytes. Render them visibly.
    console.log(safe(`Session: ${id}\nIntent: ${session.intent}\nTarget: ${review.target}\nBase: ${review.base}\nCommit: ${review.commit}\nTests: ${review.testSummary}\n${diff}`));
  } else {
    console.log(`Interrupted merge: ${id}\nTarget: ${review.target}\nBase: ${review.base}\nCommit: ${review.commit}`);
  }
  if (action === 'review') return true;
  const confirmation = await promptOperatorPassphrase('Type the full commit hash shown above: ');
  if (confirmation !== review.commit) throw new Error('commit confirmation did not match');
  await authenticateEvolution();
  if (action === 'reconcile') {
    const status = await reconcileEvolveReview(store, id, root);
    if (status === 'merged' && review.planId && review.stepIdx !== undefined) {
      try { advanceStep({ planId: review.planId, stepIdx: review.stepIdx, status: 'done', artifact: review.commit }); }
      catch { console.error('Merge is recorded, but the plan step requires operator reconciliation.'); }
    }
    console.log(`Review ${id}: ${status}. No merge was replayed.`);
    return true;
  }
  if (action === 'reject') {
    store.transition(id, 'prepared', 'rejected');
    if (review.planId && review.stepIdx !== undefined) {
      try { advanceStep({ planId: review.planId, stepIdx: review.stepIdx, status: 'failed', error: 'operator rejected prepared change' }); }
      catch { console.error('Rejection is recorded, but the plan step requires operator reconciliation.'); }
    }
    console.log(`Rejected reviewed commit ${review.commit}; its worktree remains available for inspection.`);
    return true;
  }
  const governance = await runMemphisSelfGovernanceStatus();
  if (!governance.canSelfModify) throw new Error(`self-modification blocked by governance: ${governance.blockingReasons.join('; ')}`);
  await mergeEvolveReview(store, id, root, confirmation);
  if (review.planId && review.stepIdx !== undefined) {
    try { advanceStep({ planId: review.planId, stepIdx: review.stepIdx, status: 'done', artifact: review.commit }); }
    catch { console.error('Merge completed, but the plan step requires operator reconciliation.'); }
  }
  console.log(`Merged reviewed commit ${review.commit}; restart or deployment requires a separate decision.`);
  return true;
}

async function handleEvolveRollback(context: CliContext): Promise<boolean> {
  const sessionId = context.args.target;
  if (!sessionId) {
    console.error('Usage: memphis evolve rollback <session-id>');
    return true;
  }

  // S5-1: gate before reverting agent self-modification — restoring an
  // arbitrary snapshot is destructive (loses any work since that point).
  if (!(await requireOperatorAuth())) {
    throw new Error('Operator authentication failed.');
  }

  const repo = context.getContainer().evolveSessionRepository;
  const session = repo.getById(sessionId);

  if (!session) {
    const all = repo.listRecent(100);
    const match = all.find((s) => s.id.startsWith(sessionId));
    if (!match) {
      console.error(`Session not found: ${sessionId}`);
      return true;
    }
    return handleRollbackSession(repo, match, context);
  }

  return handleRollbackSession(repo, session, context);
}

async function handleRollbackSession(
  repo: SqliteEvolveSessionRepository,
  session: { id: string; snapshotId: string | null; status: string; intent: string; branch?: string | null },
  context: CliContext,
): Promise<boolean> {
  // An interrupted preparation may have created its isolated branch before
  // it could persist a review record. Never restore that snapshot onto the
  // unrelated live worktree, including when lookup used a shortened ID.
  if (session.branch === `evolve/review-${session.id}` ||
      (typeof repo.reviewStore === 'function' && repo.reviewStore().get(session.id))) {
    throw new Error('isolated evolution cannot be restored from a snapshot by this command; inspect its worktree and use a separately reviewed revert if needed');
  }
  if (session.status === 'rolled-back') {
    console.log(`Session ${session.id.slice(0, 8)} is already rolled back.`);
    return true;
  }

  if (!session.snapshotId) {
    console.error(`Session ${session.id.slice(0, 8)} has no snapshot to rollback to.`);
    return true;
  }

  const { RollbackManager } = await import('../../../backup/rollback.js');
  const { getDataDir } = await import('../../../config/paths.js');
  const rollbackMgr = new RollbackManager(getDataDir());
  const result = await rollbackMgr.rollback(session.snapshotId);

  if (result.success) {
    repo.updateStatus(session.id, 'rolled-back', {
      errorMessage: 'manual rollback via CLI',
    });

    if (context.args.json) {
      console.log(JSON.stringify({ rolledBack: true, sessionId: session.id }, null, 2));
    } else {
      console.log(`Rolled back session ${session.id.slice(0, 8)}: ${session.intent}`);
    }
  } else {
    console.error(`Rollback failed: ${result.error ?? 'unknown'}`);
  }

  return true;
}

async function handleEvolveLog(context: CliContext): Promise<boolean> {
  const repo = context.getContainer().evolveSessionRepository;
  const sessions = (await annotateSnapshotState(repo.listRecent(50))).map((session) => {
    const store = typeof repo.reviewStore === 'function' ? repo.reviewStore() : undefined;
    return { ...session, reviewStatus: store?.get(session.id)?.status, reviewEvents: store?.events(session.id) ?? [] };
  });

  if (context.args.json) {
    console.log(JSON.stringify(sessions, null, 2));
    return true;
  }

  if (sessions.length === 0) {
    console.log('No evolution sessions found.');
    return true;
  }

  console.log('Evolution Audit Log:');
  console.log('─'.repeat(80));
  for (const s of sessions) {
    console.log(`[${s.createdAt}] ${(s.reviewStatus ?? s.status).padEnd(12)} ${s.intent}`);
    if (s.branch) console.log(`  branch: ${s.branch}`);
    if (s.committedHash) console.log(`  commit: ${s.committedHash}`);
    if (s.snapshotId) console.log(`  snapshot: ${s.snapshotId} (${s.snapshotState})`);
    if (s.errorMessage) console.log(`  error: ${s.errorMessage}`);
    for (const event of s.reviewEvents) console.log(`  ${event.at}: ${event.action} ${event.commit}`);
    console.log('');
  }
  return true;
}

async function handleEvolveCommand(context: CliContext): Promise<boolean> {
  const sub = context.args.subcommand;

  if (sub === 'status' || !sub) {
    return handleEvolveStatus(context);
  }
  if (sub === 'rollback') {
    return handleEvolveRollback(context);
  }
  if (sub === 'log') {
    return handleEvolveLog(context);
  }
  if (sub === 'review' || sub === 'approve' || sub === 'reject' || sub === 'reconcile') {
    return handleEvolveReview(context, sub);
  }
  if (sub === 'requests' || sub === 'request' || sub === 'prepare') {
    return handleEvolveRequest(context, sub);
  }

  console.error(`Unknown evolve subcommand: ${sub}`);
  console.error('Usage: memphis evolve <status|rollback|log|requests|request|prepare|review|approve|reject|reconcile> [options]');
  return true;
}

export const evolveCommandHandler: CommandHandler = {
  name: 'evolve',
  commands: ['evolve'],
  canHandle: (context: CliContext) => context.args.command === 'evolve',
  handle: handleEvolveCommand,
};
