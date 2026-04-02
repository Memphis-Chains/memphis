import { randomUUID } from 'node:crypto';

import type Database from 'better-sqlite3';

export type SessionMemorySnapshotRecord = {
  snapshotId: string;
  conversationId: string;
  actorId?: string;
  sourceSurface?: string;
  turnCount: number;
  lastSequence: number;
  summaryText: string;
  metadata: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
};

type SessionMemoryRow = {
  snapshot_id: string;
  conversation_id: string;
  actor_id?: string;
  source_surface?: string;
  turn_count: number;
  last_sequence: number;
  summary_text: string;
  metadata_json: string;
  created_at: string;
  updated_at: string;
};

function parseMetadata(raw: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function mapRow(row: SessionMemoryRow): SessionMemorySnapshotRecord {
  return {
    snapshotId: row.snapshot_id,
    conversationId: row.conversation_id,
    actorId: row.actor_id,
    sourceSurface: row.source_surface,
    turnCount: row.turn_count,
    lastSequence: row.last_sequence,
    summaryText: row.summary_text,
    metadata: parseMetadata(row.metadata_json),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export class SqliteSessionMemoryRepository {
  constructor(private readonly db: Database.Database) {}

  public getLatest(conversationId: string): SessionMemorySnapshotRecord | null {
    const row = this.db
      .prepare(
        `SELECT snapshot_id, conversation_id, actor_id, source_surface, turn_count, last_sequence,
                summary_text, metadata_json, created_at, updated_at
         FROM session_memory_snapshots
         WHERE conversation_id = ?
         ORDER BY updated_at DESC, snapshot_id DESC
         LIMIT 1`,
      )
      .get(conversationId) as SessionMemoryRow | undefined;

    return row ? mapRow(row) : null;
  }

  public save(input: {
    conversationId: string;
    actorId?: string;
    sourceSurface?: string;
    turnCount: number;
    lastSequence: number;
    summaryText: string;
    metadata?: Record<string, unknown>;
  }): SessionMemorySnapshotRecord {
    const now = new Date().toISOString();
    const snapshotId = randomUUID();
    const metadataJson = JSON.stringify(input.metadata ?? {});
    this.db
      .prepare(
        `INSERT INTO session_memory_snapshots (
           snapshot_id, conversation_id, actor_id, source_surface, turn_count, last_sequence,
           summary_text, metadata_json, created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        snapshotId,
        input.conversationId,
        input.actorId ?? null,
        input.sourceSurface ?? null,
        input.turnCount,
        input.lastSequence,
        input.summaryText,
        metadataJson,
        now,
        now,
      );

    return {
      snapshotId,
      conversationId: input.conversationId,
      actorId: input.actorId,
      sourceSurface: input.sourceSurface,
      turnCount: input.turnCount,
      lastSequence: input.lastSequence,
      summaryText: input.summaryText,
      metadata: input.metadata ?? {},
      createdAt: now,
      updatedAt: now,
    };
  }
}
