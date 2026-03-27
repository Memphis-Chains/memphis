import type Database from 'better-sqlite3';

export type OperatorChatRole = 'system' | 'user' | 'assistant' | 'tool';

export type OperatorChatMessageRecord = {
  sequence: number;
  role: OperatorChatRole;
  content: string;
  displayContent: string;
  toolCallId?: string;
  toolName?: string;
  createdAt: string;
  provider?: string;
  model?: string;
};

export type OperatorChatPersistMessage = {
  role: OperatorChatRole;
  content: string;
  displayContent?: string;
  toolCallId?: string;
  toolName?: string;
  provider?: string;
  model?: string;
};

type OperatorChatRow = {
  sequence: number;
  role: OperatorChatRole;
  content: string;
  display_content: string;
  tool_call_id?: string;
  tool_name?: string;
  created_at: string;
  provider?: string;
  model?: string;
};

function mapRow(row: OperatorChatRow): OperatorChatMessageRecord {
  return {
    sequence: row.sequence,
    role: row.role,
    content: row.content,
    displayContent: row.display_content,
    toolCallId: row.tool_call_id,
    toolName: row.tool_name,
    createdAt: row.created_at,
    provider: row.provider,
    model: row.model,
  };
}

export class SqliteOperatorChatSessionRepository {
  constructor(private readonly db: Database.Database) {}

  public listMessages(sessionId: string, limit = 40): OperatorChatMessageRecord[] {
    const rows = this.db
      .prepare(
        `SELECT sequence, role, content, display_content, tool_call_id, tool_name, created_at, provider, model
         FROM operator_chat_messages
         WHERE session_id = ?
         ORDER BY sequence DESC
         LIMIT ?`,
      )
      .all(sessionId, Math.max(1, limit)) as OperatorChatRow[];

    return rows.reverse().map(mapRow);
  }

  public hasMessages(sessionId: string): boolean {
    const row = this.db
      .prepare(
        `SELECT 1
         FROM operator_chat_messages
         WHERE session_id = ?
         LIMIT 1`,
      )
      .get(sessionId) as { 1: number } | undefined;

    return Boolean(row);
  }

  public appendMessages(sessionId: string, messages: OperatorChatPersistMessage[]): void {
    if (messages.length === 0) {
      return;
    }

    const now = new Date().toISOString();
    const tx = this.db.transaction(() => {
      this.db
        .prepare(
          `INSERT INTO sessions(id, created_at, updated_at)
           VALUES (?, ?, ?)
           ON CONFLICT(id) DO UPDATE SET updated_at = excluded.updated_at`,
        )
        .run(sessionId, now, now);

      let sequence = Number(
        (
          this.db
            .prepare(
              'SELECT COALESCE(MAX(sequence), 0) AS sequence FROM operator_chat_messages WHERE session_id = ?',
            )
            .get(sessionId) as { sequence: number }
        ).sequence ?? 0,
      );

      const insert = this.db.prepare(
        `INSERT INTO operator_chat_messages (
           session_id, sequence, role, content, display_content, tool_call_id, tool_name, tool_calls_json, provider, model, created_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      );

      for (const message of messages) {
        sequence += 1;
        insert.run(
          sessionId,
          sequence,
          message.role,
          message.content,
          message.displayContent ?? message.content,
          message.toolCallId ?? null,
          message.toolName ?? null,
          null,
          message.provider ?? null,
          message.model ?? null,
          new Date().toISOString(),
        );
      }
    });

    tx();
  }

  public clearSession(sessionId: string): void {
    const now = new Date().toISOString();
    const tx = this.db.transaction(() => {
      this.db
        .prepare(
          `INSERT INTO sessions(id, created_at, updated_at)
           VALUES (?, ?, ?)
           ON CONFLICT(id) DO UPDATE SET updated_at = excluded.updated_at`,
        )
        .run(sessionId, now, now);
      this.db.prepare('DELETE FROM operator_chat_messages WHERE session_id = ?').run(sessionId);
      this.db
        .prepare('UPDATE sessions SET updated_at = ? WHERE id = ?')
        .run(new Date().toISOString(), sessionId);
    });

    tx();
  }
}
