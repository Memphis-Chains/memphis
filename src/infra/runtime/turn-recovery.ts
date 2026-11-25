import Database from 'better-sqlite3';

import { getActiveTier3Session, type Tier3Surface } from '../../security/tier3-session.js';
import { validateOperatorPassphrase } from '../auth/operator-gate.js';

/**
 * How the operator proved they ARE the operator.
 *
 * TWO authorities, ONE owner. The CLI proves it with the passphrase; the
 * cockpit proves it with the tier-3 session it already holds — `/tier 3
 * <passphrase>` mints one, and it has a TTL.
 *
 * Both are validated HERE, by the function that writes. The rule "only
 * the operator may acknowledge a turn" therefore has one owner and one
 * gate, and the cockpit is not a second, weaker door: it reaches the same
 * function with an authority the function itself checks.
 */
export type RecoveryAuthority =
  | { kind: 'passphrase'; passphrase: string }
  | { kind: 'elevated-session'; surface: Tier3Surface; actorId: string };

export interface RecoveryTurn {
  id: string;
  sessionId: string;
  status: 'running' | 'interrupted' | 'blocked' | 'abandoned';
  updatedAt: string;
  partialBytes: number;
  partialTruncated: boolean;
  /**
   * The operations of this turn whose outcome was never determined.
   *
   * This is the ONLY thing that can have left a side effect half-applied,
   * so it is the only thing that needs a decision. A turn that failed
   * without dispatching a tool has nothing outstanding — `memphis_exec`
   * that was never called cannot have half-run.
   */
  unsettledCount: number;
  /** Does this turn need the operator to acknowledge it? */
  needsAcknowledgement: boolean;
  operations: Array<{ tool: string; status: string; exitCode?: number }>;
}

export interface LegacyOperation { id: string; sessionId: string; tool: string; status: string }

export function listLegacyOperations(databasePath: string): LegacyOperation[] {
  const db = new Database(databasePath, { readonly: true, fileMustExist: true });
  try {
    if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='operator_tool_operations'").get()) return [];
    const columns = db.pragma('table_info(operator_tool_operations)') as Array<{ name: string }>;
    const has = (name: string): boolean => columns.some((column) => column.name === name);
    const clauses = ["status IN ('started','unknown')"];
    if (has('turn_id')) clauses.push('turn_id IS NULL');
    if (has('reviewed_at')) clauses.push('reviewed_at IS NULL');
    return db.prepare(`SELECT id, session_id AS sessionId, tool_name AS tool, status FROM operator_tool_operations WHERE ${clauses.join(' AND ')} ORDER BY created_at DESC LIMIT 100`).all() as LegacyOperation[];
  } finally { db.close(); }
}

function ensureOperationColumns(db: Database.Database): boolean {
  if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='operator_tool_operations'").get()) return false;
  for (const name of ['turn_id', 'reviewed_at']) {
    const columns = db.pragma('table_info(operator_tool_operations)') as Array<{ name: string }>;
    if (!columns.some((column) => column.name === name)) db.exec(`ALTER TABLE operator_tool_operations ADD COLUMN ${name} TEXT`);
  }
  return true;
}

function requireOperator(authority: RecoveryAuthority): void {
  if (authority.kind === 'passphrase') {
    if (!authority.passphrase || !validateOperatorPassphrase(authority.passphrase)) throw new Error('operator authentication failed');
    return;
  }
  // The cockpit's authority: a tier-3 session that is still alive. The
  // session carries its own expiry, so the check is "is there a live
  // session", not "did somebody once type the passphrase".
  if (!getActiveTier3Session(authority.surface, authority.actorId)) {
    throw new Error('operator authentication failed: no active tier-3 session');
  }
}

/** Metadata only: checkpoint contents and arbitrary tool output stay private. */
export function listRecoveryTurns(databasePath: string): RecoveryTurn[] {
  const db = new Database(databasePath, { readonly: true, fileMustExist: true });
  try {
    const exists = db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='operator_turn_checkpoints'").get();
    if (!exists) return [];
    const turns = db.prepare(
      "SELECT id, session_id AS sessionId, status, updated_at AS updatedAt, length(CAST(partial_text AS BLOB)) AS partialBytes, partial_truncated AS partialTruncated FROM operator_turn_checkpoints WHERE status IN ('running','interrupted','blocked','abandoned') ORDER BY updated_at DESC LIMIT 100",
    ).all() as Array<Omit<RecoveryTurn, 'operations' | 'unsettledCount' | 'needsAcknowledgement'>>;
    const operationsExist = db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='operator_tool_operations'").get();
    const columns = operationsExist ? db.pragma('table_info(operator_tool_operations)') as Array<{ name: string }> : [];
    if (!columns.some((column) => column.name === 'turn_id')) {
      return turns.map((turn) => ({ ...turn, partialTruncated: Boolean(turn.partialTruncated), unsettledCount: 0, needsAcknowledgement: false, operations: [] }));
    }
    const hasReviewedAt = columns.some((column) => column.name === 'reviewed_at');
    const query = db.prepare('SELECT tool_name AS tool, status, result_summary AS summary FROM operator_tool_operations WHERE turn_id=? AND session_id=? ORDER BY created_at ASC LIMIT 100');
    // The same predicate the Rust arm uses (`list_recovery_turns` in
    // crates/memphis-operator/src/chat_session.rs): an operation that was
    // dispatched and never settled is the ONLY evidence of a possible
    // half-applied side effect. A turn that failed without dispatching a
    // tool has nothing outstanding to acknowledge.
    const unsettledQuery = db.prepare(
      `SELECT COUNT(*) AS n FROM operator_tool_operations op WHERE op.turn_id=? AND op.session_id=? AND op.status IN ('started','unknown') ${hasReviewedAt ? 'AND op.reviewed_at IS NULL' : ''}`,
    );
    return turns.map((turn) => {
      const unsettledCount = Number((unsettledQuery.get(turn.id, turn.sessionId) as { n: number }).n);
      return {
        ...turn, partialTruncated: Boolean(turn.partialTruncated),
        unsettledCount,
        needsAcknowledgement: unsettledCount > 0,
        operations: (query.all(turn.id, turn.sessionId) as Array<{ tool: string; status: string; summary: string | null }>).map((op) => {
          const exit = op.summary?.match(/(?:^|\s)exit=(\d+)$/);
          return { tool: op.tool, status: op.status, ...(exit ? { exitCode: Number(exit[1]) } : {}) };
        }),
      };
    });
  } finally {
    db.close();
  }
}

/** Visible streamed text is shown only for an explicit local show command. */
export function showRecoveryPartial(databasePath: string, id: string): { text: string; truncated: boolean } {
  if (!/^[0-9a-f]{32}$/.test(id)) throw new Error('invalid turn id');
  const db = new Database(databasePath, { readonly: true, fileMustExist: true });
  try {
    const row = db.prepare("SELECT partial_text AS text, partial_truncated AS truncated FROM operator_turn_checkpoints WHERE id=? AND status IN ('running','interrupted','blocked','abandoned')").get(id) as { text: string; truncated: number } | undefined;
    if (!row) throw new Error('incomplete turn not found');
    return { text: row.text, truncated: Boolean(row.truncated) };
  } finally { db.close(); }
}

export function acknowledgeRecoveryTurn(databasePath: string, id: string, authority: RecoveryAuthority, forceRunning = false): void {
  if (!/^[0-9a-f]{32}$/.test(id)) throw new Error('invalid turn id');
  requireOperator(authority);
  const db = new Database(databasePath, { fileMustExist: true });
  try {
    const hasOperations = ensureOperationColumns(db);
    db.exec("CREATE TABLE IF NOT EXISTS operator_turn_recovery_audit (turn_id TEXT NOT NULL, action TEXT NOT NULL, actor TEXT NOT NULL, created_at TEXT NOT NULL)");
    db.transaction(() => {
      const now = new Date().toISOString();
      const update = db.prepare(
        `UPDATE operator_turn_checkpoints SET status='acknowledged', updated_at=? WHERE id=? AND status ${forceRunning ? "IN ('interrupted','blocked','running','abandoned')" : "IN ('interrupted','blocked','abandoned')"}`,
      ).run(now, id);
      if (update.changes !== 1) throw new Error('turn is not interrupted, was already acknowledged, or is still running; review before using --force-running');
      if (hasOperations) db.prepare("UPDATE operator_tool_operations SET reviewed_at=? WHERE turn_id=? AND status IN ('started','unknown') AND reviewed_at IS NULL").run(now, id);
      db.prepare('INSERT INTO operator_turn_recovery_audit (turn_id, action, actor, created_at) VALUES (?, ?, ?, ?)')
        .run(id, forceRunning ? 'acknowledge-forced' : 'acknowledge', 'local-operator', now);
    })();
  } finally {
    db.close();
  }
}

export function acknowledgeLegacyOperation(databasePath: string, id: string, authority: RecoveryAuthority, forceRunning = false): void {
  // eslint-disable-next-line no-control-regex -- operation IDs must not contain control characters
  if (!id || id.length > 512 || /[\x00-\x1f\x7f]/.test(id)) throw new Error('invalid operation id');
  requireOperator(authority);
  const db = new Database(databasePath, { fileMustExist: true });
  try {
    if (!ensureOperationColumns(db)) throw new Error('operation journal not found');
    db.exec("CREATE TABLE IF NOT EXISTS operator_turn_recovery_audit (turn_id TEXT NOT NULL, action TEXT NOT NULL, actor TEXT NOT NULL, created_at TEXT NOT NULL)");
    db.transaction(() => {
      const now = new Date().toISOString();
      const state = forceRunning ? "IN ('started','unknown')" : "= 'unknown'";
      const update = db.prepare(`UPDATE operator_tool_operations SET reviewed_at=? WHERE id=? AND turn_id IS NULL AND reviewed_at IS NULL AND status ${state}`).run(now, id);
      if (update.changes !== 1) throw new Error('operation is missing, already reviewed, or may still be running; inspect before --force-running');
      db.prepare('INSERT INTO operator_turn_recovery_audit (turn_id, action, actor, created_at) VALUES (?, ?, ?, ?)')
        .run(id, forceRunning ? 'legacy-acknowledge-forced' : 'legacy-acknowledge', 'local-operator', now);
    })();
  } finally { db.close(); }
}
