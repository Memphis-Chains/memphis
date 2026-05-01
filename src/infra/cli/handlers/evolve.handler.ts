import type { CommandHandler } from './command-handler.js';
import { requireOperatorAuth } from '../../auth/operator-gate.js';
import type { SqliteEvolveSessionRepository } from '../../storage/sqlite/repositories/evolve-session-repository.js';
import type { CliContext } from '../context.js';

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
  const sessions = await annotateSnapshotState(repo.listRecent(20));

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
      `  ${icon} ${s.id.slice(0, 8)}  ${s.status.padEnd(12)} ${s.intent.slice(0, 50)}${hash}`,
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
  session: { id: string; snapshotId: string | null; status: string; intent: string },
  context: CliContext,
): Promise<boolean> {
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
  const sessions = await annotateSnapshotState(repo.listRecent(50));

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
    console.log(`[${s.createdAt}] ${s.status.padEnd(12)} ${s.intent}`);
    if (s.branch) console.log(`  branch: ${s.branch}`);
    if (s.committedHash) console.log(`  commit: ${s.committedHash}`);
    if (s.snapshotId) console.log(`  snapshot: ${s.snapshotId} (${s.snapshotState})`);
    if (s.errorMessage) console.log(`  error: ${s.errorMessage}`);
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

  console.error(`Unknown evolve subcommand: ${sub}`);
  console.error('Usage: memphis evolve <status|rollback|log> [options]');
  return true;
}

export const evolveCommandHandler: CommandHandler = {
  name: 'evolve',
  commands: ['evolve'],
  canHandle: (context: CliContext) => context.args.command === 'evolve',
  handle: handleEvolveCommand,
};
