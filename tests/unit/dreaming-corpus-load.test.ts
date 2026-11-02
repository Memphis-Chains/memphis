import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';

import { loadDreamingCorpus } from '../../src/cognitive/dreaming/load.js';
import { SqliteDreamingCorpusRepository } from '../../src/infra/storage/sqlite/repositories/dreaming-corpus-repository.js';

/**
 * D1 — the corpus is a VIEW over the operator chat log, so the seam
 * that matters is the one between the database and the builder.
 *
 * The fixture uses the real table shapes from
 * `src/infra/storage/sqlite/client.ts`, because a fixture with a
 * different shape would prove nothing about the query that runs against
 * the live database.
 */

interface MessageRow {
  session_id: string;
  sequence: number;
  role: string;
  content: string;
  tool_call_id?: string | null;
  tool_name?: string | null;
  tool_calls_json?: string | null;
  provider?: string | null;
  model?: string | null;
  created_at: string;
}

function createFixtureDb(
  sessions: Array<{ id: string; created_at: string }>,
  messages: MessageRow[],
): string {
  const root = mkdtempSync(join(tmpdir(), 'memphis-dreaming-'));
  const path = join(root, 'chat.db');
  const db = new Database(path);

  db.exec(`
    CREATE TABLE sessions (
      id TEXT PRIMARY KEY,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE operator_chat_messages (
      session_id TEXT NOT NULL,
      sequence INTEGER NOT NULL,
      role TEXT NOT NULL,
      content TEXT NOT NULL,
      display_content TEXT NOT NULL,
      tool_call_id TEXT,
      tool_name TEXT,
      tool_calls_json TEXT,
      provider TEXT,
      model TEXT,
      created_at TEXT NOT NULL,
      PRIMARY KEY(session_id, sequence)
    );
  `);

  const insertSession = db.prepare(
    'INSERT INTO sessions (id, created_at, updated_at) VALUES (?, ?, ?)',
  );
  for (const session of sessions) {
    insertSession.run(session.id, session.created_at, session.created_at);
  }

  const insertMessage = db.prepare(
    `INSERT INTO operator_chat_messages
       (session_id, sequence, role, content, display_content, tool_call_id, tool_name,
        tool_calls_json, provider, model, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  for (const message of messages) {
    insertMessage.run(
      message.session_id,
      message.sequence,
      message.role,
      message.content,
      message.content,
      message.tool_call_id ?? null,
      message.tool_name ?? null,
      message.tool_calls_json ?? null,
      message.provider ?? null,
      message.model ?? null,
      message.created_at,
    );
  }

  db.close();
  return path;
}

const userMessage: MessageRow = {
  session_id: 's1',
  sequence: 1,
  role: 'user',
  content: '<user_input>\nzrób to\n</user_input>',
  created_at: '2026-11-02T10:00:00.000Z',
};

const assistantMessage: MessageRow = {
  session_id: 's1',
  sequence: 2,
  role: 'assistant',
  content: 'robota',
  tool_calls_json: '[{"id":"call_1","name":"memphis_exec","arguments":{"cmd":"ls"}}]',
  provider: 'minimax',
  model: 'MiniMax-M3',
  created_at: '2026-11-02T10:00:01.000Z',
};

const toolMessage: MessageRow = {
  session_id: 's1',
  sequence: 3,
  role: 'tool',
  content: '<tool_output tool="memphis_exec">\n{"ok":true}\n</tool_output>',
  tool_call_id: 'call_1',
  tool_name: 'memphis_exec',
  created_at: '2026-11-02T10:00:02.000Z',
};

const failedToolMessage: MessageRow = {
  ...toolMessage,
  sequence: 4,
  content: '<tool_output tool="memphis_exec">\n{"error":"boom","exitCode":1}\n</tool_output>',
};

describe('loadDreamingCorpus', () => {
  it('reports a missing database as a missing corpus, not as an error', () => {
    const root = mkdtempSync(join(tmpdir(), 'memphis-dreaming-'));
    const corpus = loadDreamingCorpus({
      rawEnv: { DATABASE_URL: `file:${join(root, 'absent.db')}` } as NodeJS.ProcessEnv,
    });
    expect(corpus.status).toBe('missing');
    expect(corpus.turns).toEqual([]);
    expect(corpus.stats.turns).toBe(0);
  });

  it('refuses a database URL it cannot read as a file', () => {
    expect(() =>
      loadDreamingCorpus({ rawEnv: { DATABASE_URL: 'postgres://x/y' } as NodeJS.ProcessEnv }),
    ).toThrow(/Unsupported or empty SQLite database URL/);
  });

  it('builds the corpus from the real table shapes', () => {
    const path = createFixtureDb(
      [{ id: 's1', created_at: '2026-11-02T09:00:00.000Z' }],
      [userMessage, assistantMessage, toolMessage],
    );

    const corpus = loadDreamingCorpus({
      rawEnv: { DATABASE_URL: `file:${path}` } as NodeJS.ProcessEnv,
    });

    expect(corpus.status).toBe('ok');
    expect(corpus.stats.turns).toBe(3);
    expect(corpus.stats.sessions).toBe(1);
    expect(corpus.stats.userTurns).toBe(1);
    expect(corpus.stats.assistantTurns).toBe(1);
    expect(corpus.stats.toolTurns).toBe(1);
    expect(corpus.stats.calls).toBe(1);
    expect(corpus.stats.callsWithOutcome).toBe(1);
    expect(corpus.stats.failures).toBe(0);
    expect(corpus.stats.unknownOutcomes).toBe(0);
    expect(corpus.stats.unparsed).toBe(0);
    expect(corpus.stats.wrapped).toBe(2);

    const assistantTurn = corpus.turns.find((turn) => turn.role === 'assistant');
    expect(assistantTurn?.calls?.[0]?.name).toBe('memphis_exec');
    expect(assistantTurn?.calls?.[0]?.outcome?.ok).toBe(true);

    const userTurn = corpus.turns.find((turn) => turn.role === 'user');
    expect(userTurn?.text).toBe('zrób to');
  });

  it('counts a failed tool result structurally', () => {
    const path = createFixtureDb(
      [{ id: 's1', created_at: '2026-11-02T09:00:00.000Z' }],
      [userMessage, assistantMessage, failedToolMessage],
    );

    const corpus = loadDreamingCorpus({
      rawEnv: { DATABASE_URL: `file:${path}` } as NodeJS.ProcessEnv,
    });

    expect(corpus.stats.failures).toBe(1);
    expect(corpus.stats.unknownOutcomes).toBe(0);
    const toolTurn = corpus.turns.find((turn) => turn.role === 'tool');
    expect(toolTurn?.outcome?.ok).toBe(false);
    expect(toolTurn?.outcome?.error).toBe('boom');
  });

  it('windows the corpus by the session it belongs to', () => {
    const path = createFixtureDb(
      [
        { id: 's1', created_at: '2026-10-01T09:00:00.000Z' },
        { id: 's2', created_at: '2026-11-02T09:00:00.000Z' },
      ],
      [
        userMessage,
        assistantMessage,
        toolMessage,
        { ...userMessage, session_id: 's2', sequence: 1 },
        { ...assistantMessage, session_id: 's2', sequence: 2 },
        { ...toolMessage, session_id: 's2', sequence: 3 },
      ],
    );

    const onlyRecent = loadDreamingCorpus({
      rawEnv: { DATABASE_URL: `file:${path}` } as NodeJS.ProcessEnv,
      since: '2026-11-01T00:00:00.000Z',
    });
    expect(onlyRecent.stats.sessions).toBe(1);
    expect(onlyRecent.stats.turns).toBe(3);

    const onlyOld = loadDreamingCorpus({
      rawEnv: { DATABASE_URL: `file:${path}` } as NodeJS.ProcessEnv,
      until: '2026-11-01T00:00:00.000Z',
    });
    expect(onlyOld.stats.sessions).toBe(1);
    expect(onlyOld.stats.turns).toBe(3);
  });

  it('caps the rows it reads, because the corpus is a view and not a copy', () => {
    const path = createFixtureDb(
      [{ id: 's1', created_at: '2026-11-02T09:00:00.000Z' }],
      [userMessage, assistantMessage, toolMessage],
    );

    const corpus = loadDreamingCorpus({
      rawEnv: { DATABASE_URL: `file:${path}` } as NodeJS.ProcessEnv,
      limit: 2,
    });
    expect(corpus.stats.turns).toBe(2);
  });
});

describe('SqliteDreamingCorpusRepository', () => {
  it('counts the messages and the sessions it would read', () => {
    const path = createFixtureDb(
      [
        { id: 's1', created_at: '2026-11-02T09:00:00.000Z' },
        { id: 's2', created_at: '2026-11-02T09:00:00.000Z' },
      ],
      [userMessage, assistantMessage, toolMessage, { ...userMessage, session_id: 's2' }],
    );

    const db = new Database(path, { readonly: true });
    try {
      const repository = new SqliteDreamingCorpusRepository(db);
      expect(repository.count()).toEqual({ messages: 4, sessions: 2 });
    } finally {
      db.close();
    }
  });

  it('reads the rows in session and sequence order', () => {
    const path = createFixtureDb(
      [{ id: 's1', created_at: '2026-11-02T09:00:00.000Z' }],
      [userMessage, assistantMessage, toolMessage],
    );

    const db = new Database(path, { readonly: true });
    try {
      const repository = new SqliteDreamingCorpusRepository(db);
      const rows = repository.listRows();
      expect(rows.map((row) => row.sequence)).toEqual([1, 2, 3]);
      expect(rows[0]?.content).toContain('<user_input>');
    } finally {
      db.close();
    }
  });
});
