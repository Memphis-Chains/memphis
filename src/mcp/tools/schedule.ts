import type Database from 'better-sqlite3';

// ─── Types ───────────────────────────────────────────────────────────

export type JobStatus = 'pending' | 'active' | 'completed' | 'failed' | 'canceled';

export interface ScheduledJob {
  id: string;
  type: string;
  payload: string;
  status: JobStatus;
  scheduledAtMs: number;
  intervalMs: number | null;
  lastRunAt: string | null;
  retryCount: number;
  maxRetries: number;
  errorMessage: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ScheduleCreateInput {
  type: string;
  payload?: string;
  delayMs?: number;
  intervalMs?: number;
  maxRetries?: number;
}

export interface ScheduleCreateOutput {
  created: boolean;
  id: string;
  scheduledAt?: string;
  error?: string;
}

export interface ScheduleListInput {
  status?: JobStatus;
  limit?: number;
}

export interface ScheduleListOutput {
  count: number;
  jobs: ScheduledJob[];
}

export interface ScheduleCancelInput {
  id: string;
}

export interface ScheduleCancelOutput {
  canceled: boolean;
  id: string;
  error?: string;
}

// ─── Repository ──────────────────────────────────────────────────────

interface JobRow {
  id: string;
  type: string;
  payload: string;
  status: string;
  scheduled_at_ms: number;
  interval_ms: number | null;
  last_run_at: string | null;
  retry_count: number;
  max_retries: number;
  error_message: string | null;
  created_at: string;
  updated_at: string;
}

function mapRow(row: JobRow): ScheduledJob {
  return {
    id: row.id,
    type: row.type,
    payload: row.payload,
    status: row.status as JobStatus,
    scheduledAtMs: row.scheduled_at_ms,
    intervalMs: row.interval_ms,
    lastRunAt: row.last_run_at,
    retryCount: row.retry_count,
    maxRetries: row.max_retries,
    errorMessage: row.error_message,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export class SqliteScheduledJobRepository {
  constructor(private readonly db: Database.Database) {}

  create(input: ScheduleCreateInput): ScheduledJob {
    const id = crypto.randomUUID();
    const now = new Date().toISOString();
    const scheduledAtMs = Date.now() + (input.delayMs ?? 0);

    this.db
      .prepare(
        `INSERT INTO scheduled_jobs (id, type, payload, status, scheduled_at_ms, interval_ms, max_retries, created_at, updated_at)
         VALUES (?, ?, ?, 'pending', ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        input.type,
        input.payload ?? '{}',
        scheduledAtMs,
        input.intervalMs ?? null,
        input.maxRetries ?? 3,
        now,
        now,
      );

    return this.getById(id)!;
  }

  getById(id: string): ScheduledJob | null {
    const row = this.db.prepare('SELECT * FROM scheduled_jobs WHERE id = ?').get(id) as
      | JobRow
      | undefined;
    return row ? mapRow(row) : null;
  }

  listByStatus(status?: JobStatus, limit = 50): ScheduledJob[] {
    if (status) {
      return (
        this.db
          .prepare(
            'SELECT * FROM scheduled_jobs WHERE status = ? ORDER BY scheduled_at_ms ASC LIMIT ?',
          )
          .all(status, limit) as JobRow[]
      ).map(mapRow);
    }
    return (
      this.db
        .prepare('SELECT * FROM scheduled_jobs ORDER BY scheduled_at_ms ASC LIMIT ?')
        .all(limit) as JobRow[]
    ).map(mapRow);
  }

  listDueNow(): ScheduledJob[] {
    const now = Date.now();
    return (
      this.db
        .prepare(
          `SELECT * FROM scheduled_jobs WHERE status = 'pending' AND scheduled_at_ms <= ? ORDER BY scheduled_at_ms ASC`,
        )
        .all(now) as JobRow[]
    ).map(mapRow);
  }

  markActive(id: string): void {
    const now = new Date().toISOString();
    this.db
      .prepare(
        `UPDATE scheduled_jobs SET status = 'active', last_run_at = ?, updated_at = ? WHERE id = ?`,
      )
      .run(now, now, id);
  }

  markCompleted(id: string): void {
    const now = new Date().toISOString();
    this.db
      .prepare(`UPDATE scheduled_jobs SET status = 'completed', updated_at = ? WHERE id = ?`)
      .run(now, id);
  }

  markFailed(id: string, error: string): void {
    const now = new Date().toISOString();
    this.db
      .prepare(
        `UPDATE scheduled_jobs SET status = 'failed', error_message = ?, retry_count = retry_count + 1, updated_at = ? WHERE id = ?`,
      )
      .run(error, now, id);
  }

  cancel(id: string): boolean {
    const result = this.db
      .prepare(
        `UPDATE scheduled_jobs SET status = 'canceled', updated_at = ? WHERE id = ? AND status IN ('pending', 'active')`,
      )
      .run(new Date().toISOString(), id);
    return result.changes > 0;
  }

  reschedule(id: string): void {
    const job = this.getById(id);
    if (!job || !job.intervalMs) return;
    const now = new Date().toISOString();
    const nextMs = Date.now() + job.intervalMs;
    this.db
      .prepare(
        `UPDATE scheduled_jobs SET status = 'pending', scheduled_at_ms = ?, updated_at = ? WHERE id = ?`,
      )
      .run(nextMs, now, id);
  }

  recoverStaleActive(): number {
    const now = new Date().toISOString();
    const result = this.db
      .prepare(
        `UPDATE scheduled_jobs SET status = 'pending', updated_at = ? WHERE status = 'active'`,
      )
      .run(now);
    return result.changes;
  }

  prune(olderThanMs: number): number {
    const cutoff = Date.now() - olderThanMs;
    const result = this.db
      .prepare(
        `DELETE FROM scheduled_jobs WHERE status IN ('completed', 'canceled', 'failed') AND scheduled_at_ms < ?`,
      )
      .run(cutoff);
    return result.changes;
  }
}

// ─── MCP tool handlers ──────────────────────────────────────────────

export function runMemphisScheduleCreate(
  input: ScheduleCreateInput,
  repo: SqliteScheduledJobRepository,
): ScheduleCreateOutput {
  try {
    const job = repo.create(input);
    return {
      created: true,
      id: job.id,
      scheduledAt: new Date(job.scheduledAtMs).toISOString(),
    };
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return { created: false, id: '', error: msg };
  }
}

export function runMemphisScheduleList(
  input: ScheduleListInput,
  repo: SqliteScheduledJobRepository,
): ScheduleListOutput {
  const jobs = repo.listByStatus(input.status, input.limit ?? 50);
  return { count: jobs.length, jobs };
}

export function runMemphisScheduleCancel(
  input: ScheduleCancelInput,
  repo: SqliteScheduledJobRepository,
): ScheduleCancelOutput {
  const canceled = repo.cancel(input.id);
  if (!canceled) {
    return { canceled: false, id: input.id, error: 'Job not found or not in cancelable state' };
  }
  return { canceled: true, id: input.id };
}
