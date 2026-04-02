import { randomUUID } from 'node:crypto';

import type Database from 'better-sqlite3';

export type ConversationCompactionRecord = {
  compactionId: string;
  conversationId: string;
  startSequence: number;
  endSequence: number;
  summaryText: string;
  metadata: Record<string, unknown>;
  createdAt: string;
};

type ConversationCompactionRow = {
  compaction_id: string;
  conversation_id: string;
  start_sequence: number;
  end_sequence: number;
  summary_text: string;
  metadata_json: string;
  created_at: string;
};

function parseMetadata(raw: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function mapRow(row: ConversationCompactionRow): ConversationCompactionRecord {
  return {
    compactionId: row.compaction_id,
    conversationId: row.conversation_id,
    startSequence: row.start_sequence,
    endSequence: row.end_sequence,
    summaryText: row.summary_text,
    metadata: parseMetadata(row.metadata_json),
    createdAt: row.created_at,
  };
}

export class SqliteConversationCompactionRepository {
  constructor(private readonly db: Database.Database) {}

  public getLatestEndSequence(conversationId: string): number {
    const row = this.db
      .prepare(
        `SELECT COALESCE(MAX(end_sequence), 0) AS end_sequence
         FROM conversation_compactions
         WHERE conversation_id = ?`,
      )
      .get(conversationId) as { end_sequence: number } | undefined;

    return Number(row?.end_sequence ?? 0);
  }

  public listRecent(
    conversationId: string,
    limit = 3,
  ): ConversationCompactionRecord[] {
    const rows = this.db
      .prepare(
        `SELECT compaction_id, conversation_id, start_sequence, end_sequence, summary_text, metadata_json, created_at
         FROM conversation_compactions
         WHERE conversation_id = ?
         ORDER BY end_sequence DESC, created_at DESC
         LIMIT ?`,
      )
      .all(conversationId, Math.max(1, limit)) as ConversationCompactionRow[];

    return rows.map(mapRow).reverse();
  }

  public save(input: {
    conversationId: string;
    startSequence: number;
    endSequence: number;
    summaryText: string;
    metadata?: Record<string, unknown>;
  }): ConversationCompactionRecord {
    const now = new Date().toISOString();
    const existing = this.db
      .prepare(
        `SELECT compaction_id, conversation_id, start_sequence, end_sequence, summary_text, metadata_json, created_at
         FROM conversation_compactions
         WHERE conversation_id = ? AND start_sequence = ? AND end_sequence = ?
         LIMIT 1`,
      )
      .get(
        input.conversationId,
        input.startSequence,
        input.endSequence,
      ) as ConversationCompactionRow | undefined;
    if (existing) return mapRow(existing);

    const compactionId = randomUUID();
    this.db
      .prepare(
        `INSERT INTO conversation_compactions (
           compaction_id, conversation_id, start_sequence, end_sequence, summary_text, metadata_json, created_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        compactionId,
        input.conversationId,
        input.startSequence,
        input.endSequence,
        input.summaryText,
        JSON.stringify(input.metadata ?? {}),
        now,
      );

    return {
      compactionId,
      conversationId: input.conversationId,
      startSequence: input.startSequence,
      endSequence: input.endSequence,
      summaryText: input.summaryText,
      metadata: input.metadata ?? {},
      createdAt: now,
    };
  }
}
