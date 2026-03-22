import { randomUUID } from 'node:crypto';

import type Database from 'better-sqlite3';

export type EvolveSessionStatus =
  | 'pending'
  | 'approved'
  | 'active'
  | 'committed'
  | 'rolled-back'
  | 'expired';

export interface EvolveSession {
  id: string;
  authorizedAt: string;
  expiresAtMs: number;
  intent: string;
  snapshotId: string | null;
  branch: string | null;
  filesAllowed: string[];
  status: EvolveSessionStatus;
  committedHash: string | null;
  errorMessage: string | null;
  createdAt: string;
  updatedAt: string;
}

interface EvolveSessionRow {
  id: string;
  authorized_at: string;
  expires_at_ms: number;
  intent: string;
  snapshot_id: string | null;
  branch: string | null;
  files_allowed_json: string | null;
  status: string;
  committed_hash: string | null;
  error_message: string | null;
  created_at: string;
  updated_at: string;
}

function mapRow(row: EvolveSessionRow): EvolveSession {
  return {
    id: row.id,
    authorizedAt: row.authorized_at,
    expiresAtMs: row.expires_at_ms,
    intent: row.intent,
    snapshotId: row.snapshot_id,
    branch: row.branch,
    filesAllowed: row.files_allowed_json ? (JSON.parse(row.files_allowed_json) as string[]) : [],
    status: row.status as EvolveSessionStatus,
    committedHash: row.committed_hash,
    errorMessage: row.error_message,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

const DEFAULT_TTL_MS = 30 * 60 * 1000; // 30 minutes

export class SqliteEvolveSessionRepository {
  constructor(private readonly db: Database.Database) {}

  create(input: {
    intent: string;
    filesAllowed: string[];
    ttlMs?: number;
  }): EvolveSession {
    const now = new Date().toISOString();
    const id = randomUUID();
    const ttl = input.ttlMs ?? DEFAULT_TTL_MS;

    this.db
      .prepare(
        `INSERT INTO evolve_sessions
         (id, authorized_at, expires_at_ms, intent, files_allowed_json, status, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, 'pending', ?, ?)`,
      )
      .run(id, now, Date.now() + ttl, input.intent, JSON.stringify(input.filesAllowed), now, now);

    return this.getById(id)!;
  }

  getById(id: string): EvolveSession | null {
    const row = this.db
      .prepare('SELECT * FROM evolve_sessions WHERE id = ?')
      .get(id) as EvolveSessionRow | undefined;

    return row ? mapRow(row) : null;
  }

  listByStatus(status: EvolveSessionStatus): EvolveSession[] {
    const rows = this.db
      .prepare('SELECT * FROM evolve_sessions WHERE status = ? ORDER BY created_at DESC')
      .all(status) as EvolveSessionRow[];

    return rows.map(mapRow);
  }

  listRecent(limit: number = 20): EvolveSession[] {
    const rows = this.db
      .prepare('SELECT * FROM evolve_sessions ORDER BY created_at DESC LIMIT ?')
      .all(limit) as EvolveSessionRow[];

    return rows.map(mapRow);
  }

  updateStatus(
    id: string,
    status: EvolveSessionStatus,
    extra?: {
      snapshotId?: string;
      branch?: string;
      committedHash?: string;
      errorMessage?: string;
    },
  ): EvolveSession | null {
    const now = new Date().toISOString();
    const session = this.getById(id);
    if (!session) return null;

    const sets: string[] = ['status = ?', 'updated_at = ?'];
    const params: unknown[] = [status, now];

    if (extra?.snapshotId !== undefined) {
      sets.push('snapshot_id = ?');
      params.push(extra.snapshotId);
    }
    if (extra?.branch !== undefined) {
      sets.push('branch = ?');
      params.push(extra.branch);
    }
    if (extra?.committedHash !== undefined) {
      sets.push('committed_hash = ?');
      params.push(extra.committedHash);
    }
    if (extra?.errorMessage !== undefined) {
      sets.push('error_message = ?');
      params.push(extra.errorMessage);
    }

    params.push(id);
    this.db.prepare(`UPDATE evolve_sessions SET ${sets.join(', ')} WHERE id = ?`).run(...params);

    return this.getById(id);
  }

  expireSessions(nowMs: number = Date.now()): number {
    const result = this.db
      .prepare(
        `UPDATE evolve_sessions
         SET status = 'expired', updated_at = ?
         WHERE status IN ('pending', 'approved', 'active')
           AND expires_at_ms < ?`,
      )
      .run(new Date().toISOString(), nowMs);

    return result.changes;
  }

  findActiveSession(): EvolveSession | null {
    const row = this.db
      .prepare(
        `SELECT * FROM evolve_sessions
         WHERE status = 'active'
         ORDER BY created_at DESC
         LIMIT 1`,
      )
      .get() as EvolveSessionRow | undefined;

    return row ? mapRow(row) : null;
  }
}
