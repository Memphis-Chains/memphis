import Database from 'better-sqlite3';

import { validateOperatorPassphrase } from '../auth/operator-gate.js';

export interface RecoveryTurn {
  id: string;
  sessionId: string;
  status: 'running' | 'interrupted' | 'blocked';
  updatedAt: string;
  partialBytes: number;
  partialTruncated: boolean;
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

function requireOperator(passphrase: string): void {
  if (!passphrase || !validateOperatorPassphrase(passphrase)) throw new Error('operator authentication failed');
}

/** Metadata only: checkpoint contents and arbitrary tool output stay private. */
export function listRecoveryTurns(databasePath: string): RecoveryTurn[] {
  const db = new Database(databasePath, { readonly: true, fileMustExist: true });
  try {
    const exists = db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='operator_turn_checkpoints'").get();
    if (!exists) return [];
    const turns = db.prepare(
      "SELECT id, session_id AS sessionId, status, updated_at AS updatedAt, length(CAST(partial_text AS BLOB)) AS partialBytes, partial_truncated AS partialTruncated FROM operator_turn_checkpoints WHERE status IN ('running','interrupted','blocked') ORDER BY updated_at DESC LIMIT 100",
    ).all() as Array<Omit<RecoveryTurn, 'operations'>>;
    const operationsExist = db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='operator_tool_operations'").get();
    const columns = operationsExist ? db.pragma('table_info(operator_tool_operations)') as Array<{ name: string }> : [];
    if (!columns.some((column) => column.name === 'turn_id')) return turns.map((turn) => ({ ...turn, partialTruncated: Boolean(turn.partialTruncated), operations: [] }));
    const query = db.prepare('SELECT tool_name AS tool, status, result_summary AS summary FROM operator_tool_operations WHERE turn_id=? AND session_id=? ORDER BY created_at ASC LIMIT 100');
    return turns.map((turn) => ({
      ...turn, partialTruncated: Boolean(turn.partialTruncated),
      operations: (query.all(turn.id, turn.sessionId) as Array<{ tool: string; status: string; summary: string | null }>).map((op) => {
        const exit = op.summary?.match(/(?:^|\s)exit=(\d+)$/);
        return { tool: op.tool, status: op.status, ...(exit ? { exitCode: Number(exit[1]) } : {}) };
      }),
    }));
  } finally {
    db.close();
  }
}

/** Visible streamed text is shown only for an explicit local show command. */
export function showRecoveryPartial(databasePath: string, id: string): { text: string; truncated: boolean } {
  if (!/^[0-9a-f]{32}$/.test(id)) throw new Error('invalid turn id');
  const db = new Database(databasePath, { readonly: true, fileMustExist: true });
  try {
    const row = db.prepare("SELECT partial_text AS text, partial_truncated AS truncated FROM operator_turn_checkpoints WHERE id=? AND status IN ('running','interrupted','blocked')").get(id) as { text: string; truncated: number } | undefined;
    if (!row) throw new Error('incomplete turn not found');
    return { text: row.text, truncated: Boolean(row.truncated) };
  } finally { db.close(); }
}

export function acknowledgeRecoveryTurn(databasePath: string, id: string, passphrase: string, forceRunning = false): void {
  if (!/^[0-9a-f]{32}$/.test(id)) throw new Error('invalid turn id');
  requireOperator(passphrase);
  const db = new Database(databasePath, { fileMustExist: true });
  try {
    const hasOperations = ensureOperationColumns(db);
    db.exec("CREATE TABLE IF NOT EXISTS operator_turn_recovery_audit (turn_id TEXT NOT NULL, action TEXT NOT NULL, actor TEXT NOT NULL, created_at TEXT NOT NULL)");
    db.transaction(() => {
      const now = new Date().toISOString();
      const update = db.prepare(
        `UPDATE operator_turn_checkpoints SET status='acknowledged', updated_at=? WHERE id=? AND status ${forceRunning ? "IN ('interrupted','blocked','running')" : "IN ('interrupted','blocked')"}`,
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

export function acknowledgeLegacyOperation(databasePath: string, id: string, passphrase: string, forceRunning = false): void {
  // eslint-disable-next-line no-control-regex -- operation IDs must not contain control characters
  if (!id || id.length > 512 || /[\x00-\x1f\x7f]/.test(id)) throw new Error('invalid operation id');
  requireOperator(passphrase);
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
