import type Database from 'better-sqlite3';

export type WebhookEventStatus = 'pending' | 'processing' | 'completed' | 'failed';

export interface WebhookEvent {
  eventId: string;
  source: string;
  eventType: string;
  payload: string;
  status: WebhookEventStatus;
  retryCount: number;
  maxRetries: number;
  errorMessage: string | null;
  receivedAt: number;
  processedAt: number | null;
  createdAt: string;
  updatedAt: string;
}

interface WebhookEventRow {
  event_id: string;
  source: string;
  event_type: string;
  payload: string;
  status: string;
  retry_count: number;
  max_retries: number;
  error_message: string | null;
  received_at: number;
  processed_at: number | null;
  created_at: string;
  updated_at: string;
}

function mapRow(row: WebhookEventRow): WebhookEvent {
  return {
    eventId: row.event_id,
    source: row.source,
    eventType: row.event_type,
    payload: row.payload,
    status: row.status as WebhookEventStatus,
    retryCount: row.retry_count,
    maxRetries: row.max_retries,
    errorMessage: row.error_message,
    receivedAt: row.received_at,
    processedAt: row.processed_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export class SqliteWebhookEventRepository {
  constructor(private readonly db: Database.Database) {}

  /** Check if an event has already been received (idempotency). */
  has(eventId: string): boolean {
    const row = this.db.prepare('SELECT 1 FROM webhook_events WHERE event_id = ?').get(eventId);
    return row !== undefined;
  }

  /** Record a new webhook event. Returns false if duplicate. */
  record(eventId: string, source: string, eventType: string, payload: string): boolean {
    const now = new Date().toISOString();
    const result = this.db
      .prepare(
        `INSERT OR IGNORE INTO webhook_events
         (event_id, source, event_type, payload, status, received_at, created_at, updated_at)
         VALUES (?, ?, ?, ?, 'pending', ?, ?, ?)`,
      )
      .run(eventId, source, eventType, payload, Date.now(), now, now);
    return result.changes > 0;
  }

  /** Get a single event by ID. */
  getById(eventId: string): WebhookEvent | null {
    const row = this.db.prepare('SELECT * FROM webhook_events WHERE event_id = ?').get(eventId) as
      | WebhookEventRow
      | undefined;
    return row ? mapRow(row) : null;
  }

  /** List events by status. */
  listByStatus(status: WebhookEventStatus, limit = 50): WebhookEvent[] {
    return (
      this.db
        .prepare('SELECT * FROM webhook_events WHERE status = ? ORDER BY received_at ASC LIMIT ?')
        .all(status, limit) as WebhookEventRow[]
    ).map(mapRow);
  }

  /** Get pending events ready for processing. */
  listPending(limit = 50): WebhookEvent[] {
    return this.listByStatus('pending', limit);
  }

  /** Mark an event as processing. */
  markProcessing(eventId: string): void {
    const now = new Date().toISOString();
    this.db
      .prepare(`UPDATE webhook_events SET status = 'processing', updated_at = ? WHERE event_id = ?`)
      .run(now, eventId);
  }

  /** Mark an event as completed. */
  markCompleted(eventId: string): void {
    const now = new Date().toISOString();
    this.db
      .prepare(
        `UPDATE webhook_events SET status = 'completed', processed_at = ?, updated_at = ? WHERE event_id = ?`,
      )
      .run(Date.now(), now, eventId);
  }

  /** Mark an event as failed with error message. */
  markFailed(eventId: string, error: string): void {
    const now = new Date().toISOString();
    this.db
      .prepare(
        `UPDATE webhook_events SET status = 'failed', error_message = ?, retry_count = retry_count + 1, updated_at = ? WHERE event_id = ?`,
      )
      .run(error, now, eventId);
  }

  /** Reset failed events back to pending for retry (respects max_retries). */
  retryFailed(eventId: string): boolean {
    const now = new Date().toISOString();
    const result = this.db
      .prepare(
        `UPDATE webhook_events SET status = 'pending', error_message = NULL, updated_at = ?
         WHERE event_id = ? AND status = 'failed' AND retry_count < max_retries`,
      )
      .run(now, eventId);
    return result.changes > 0;
  }

  /** Recover stale 'processing' events back to pending (for crash recovery). */
  recoverStaleProcessing(): number {
    const now = new Date().toISOString();
    const result = this.db
      .prepare(
        `UPDATE webhook_events SET status = 'pending', updated_at = ? WHERE status = 'processing'`,
      )
      .run(now);
    return result.changes;
  }

  /** Prune old completed/failed events. */
  prune(olderThanMs: number): number {
    const cutoff = Date.now() - olderThanMs;
    const result = this.db
      .prepare(
        `DELETE FROM webhook_events WHERE status IN ('completed', 'failed') AND received_at < ?`,
      )
      .run(cutoff);
    return result.changes;
  }
}
