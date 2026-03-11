import type Database from 'better-sqlite3';

import type {
  GenerationEventRecord,
  GenerationEventRepository,
} from '../../../../core/contracts/repository.js';

function mapRow(row: {
  id: string;
  session_id: string | null;
  provider_used: string;
  model_used: string | null;
  timing_ms: number;
  request_id: string | null;
  created_at: string;
}): GenerationEventRecord {
  return {
    id: row.id,
    sessionId: row.session_id ?? undefined,
    providerUsed: row.provider_used,
    modelUsed: row.model_used ?? undefined,
    timingMs: row.timing_ms,
    requestId: row.request_id ?? undefined,
    createdAt: row.created_at,
  };
}

export class SqliteGenerationEventRepository implements GenerationEventRepository {
  constructor(private readonly db: Database.Database) {}

  public create(event: Omit<GenerationEventRecord, 'createdAt'>): GenerationEventRecord {
    const createdAt = new Date().toISOString();

    this.db
      .prepare(
        `INSERT INTO generation_events(id, session_id, provider_used, model_used, timing_ms, request_id, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        event.id,
        event.sessionId ?? null,
        event.providerUsed,
        event.modelUsed ?? null,
        event.timingMs,
        event.requestId ?? null,
        createdAt,
      );

    const row = this.db
      .prepare(
        `SELECT id, session_id, provider_used, model_used, timing_ms, request_id, created_at
         FROM generation_events
         WHERE id = ?`,
      )
      .get(event.id) as
      | {
          id: string;
          session_id: string | null;
          provider_used: string;
          model_used: string | null;
          timing_ms: number;
          request_id: string | null;
          created_at: string;
        }
      | undefined;

    if (!row) {
      throw new Error(`Generation event not found after insert: ${event.id}`);
    }

    return mapRow(row);
  }

  public listBySession(sessionId: string): GenerationEventRecord[] {
    const rows = this.db
      .prepare(
        `SELECT id, session_id, provider_used, model_used, timing_ms, request_id, created_at
         FROM generation_events
         WHERE session_id = ?
         ORDER BY created_at DESC`,
      )
      .all(sessionId) as Array<{
      id: string;
      session_id: string | null;
      provider_used: string;
      model_used: string | null;
      timing_ms: number;
      request_id: string | null;
      created_at: string;
    }>;

    return rows.map(mapRow);
  }
}
