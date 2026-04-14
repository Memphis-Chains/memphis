/**
 * memphis_db — SQLite database query tool.
 *
 * Uses the existing better-sqlite3 dependency for safe, synchronous access.
 */

import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import Database from 'better-sqlite3';

export type DbAction = 'query' | 'execute' | 'tables' | 'schema';

export type MemphisDbInput = {
  action: DbAction;
  /** SQL query (required for 'query' and 'execute') */
  sql?: string;
  /** Path to SQLite database file (defaults to Memphis main DB) */
  database?: string;
};

export type MemphisDbOutput = {
  action: DbAction;
  rows?: Record<string, unknown>[];
  columns?: string[];
  affected?: number;
  tables?: string[];
  schema?: string;
  error?: string;
};

const MAX_ROWS = 500;
const PROJECT_ROOT = path.join(os.homedir(), 'memphis');

function resolveDbPath(database?: string): string {
  if (!database) {
    return path.join(PROJECT_ROOT, 'data', 'memphis.db');
  }
  const resolved = database.startsWith('~/')
    ? path.join(os.homedir(), database.slice(2))
    : path.resolve(PROJECT_ROOT, database);

  // Sandbox to project
  const normalized = path.normalize(resolved);
  const memphisDir = path.join(os.homedir(), 'memphis');
  if (!normalized.startsWith(memphisDir + path.sep) && normalized !== memphisDir) {
    throw new Error(`Database path '${resolved}' is outside ~/memphis/`);
  }
  return resolved;
}

/**
 * Strip SQL comments before opcode detection. Without this, the DROP/ALTER
 * guard is bypassed by leading comments:
 *   /* filler *\/ DROP TABLE ...
 *   -- filler\nALTER TABLE ...
 * Per Codex P1 on PR #76.
 *
 * Handles:
 *   • block comments   /* ... *\/
 *   • line comments    -- ... <newline>
 *   • interleaved whitespace
 *
 * Does NOT attempt to strip string-literal content; any SQL reaching this
 * validator should be a single canonical statement, not an attempt to hide
 * DDL in a string that's then somehow re-executed.
 */
function stripSqlCommentsAndWhitespace(sql: string): string {
  let out = '';
  let i = 0;
  while (i < sql.length) {
    const c = sql[i];
    const next = sql[i + 1];
    if (c === '/' && next === '*') {
      const end = sql.indexOf('*/', i + 2);
      i = end === -1 ? sql.length : end + 2;
      continue;
    }
    if (c === '-' && next === '-') {
      const end = sql.indexOf('\n', i + 2);
      i = end === -1 ? sql.length : end + 1;
      continue;
    }
    out += c;
    i += 1;
  }
  return out.trimStart();
}

// Exported for direct unit testing (so the comment-bypass regression test
// doesn't have to stand up a real SQLite database to exercise the guard).
export function validateSql(sql: string, action: DbAction): string | undefined {
  const stripped = stripSqlCommentsAndWhitespace(sql);
  const trimmed = stripped.toUpperCase();
  // Block dangerous operations — checked AFTER comment stripping so
  // `/*x*/DROP TABLE foo` and `--evil\nALTER TABLE bar` don't slip through.
  if (
    trimmed.startsWith('DROP ') ||
    trimmed.startsWith('ALTER ') ||
    trimmed.startsWith('DROP\t') ||
    trimmed.startsWith('ALTER\t') ||
    trimmed.startsWith('DROP\n') ||
    trimmed.startsWith('ALTER\n')
  ) {
    return 'DROP and ALTER statements are blocked for safety';
  }
  if (
    action === 'query' &&
    !trimmed.startsWith('SELECT') &&
    !trimmed.startsWith('WITH') &&
    !trimmed.startsWith('EXPLAIN') &&
    !trimmed.startsWith('PRAGMA')
  ) {
    return `Action 'query' only supports SELECT, WITH, EXPLAIN, and PRAGMA statements`;
  }
  return undefined;
}

export function runMemphisDb(input: MemphisDbInput): MemphisDbOutput {
  try {
    const dbPath = resolveDbPath(input.database);

    if (!existsSync(dbPath)) {
      return { action: input.action, error: `Database not found: ${dbPath}` };
    }

    const db = new Database(dbPath, { readonly: input.action === 'query' || input.action === 'tables' || input.action === 'schema' });

    try {
      switch (input.action) {
        case 'tables': {
          const rows = db.prepare(
            "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name"
          ).all() as { name: string }[];
          return { action: 'tables', tables: rows.map((r) => r.name) };
        }

        case 'schema': {
          const rows = db.prepare(
            "SELECT sql FROM sqlite_master WHERE type IN ('table','index','view') AND sql IS NOT NULL ORDER BY type, name"
          ).all() as { sql: string }[];
          return { action: 'schema', schema: rows.map((r) => r.sql).join(';\n\n') };
        }

        case 'query': {
          if (!input.sql) return { action: 'query', error: 'sql is required for query action' };
          const validationErr = validateSql(input.sql, 'query');
          if (validationErr) return { action: 'query', error: validationErr };

          const stmt = db.prepare(input.sql);
          const rows = stmt.all() as Record<string, unknown>[];
          const truncated = rows.length > MAX_ROWS;
          const resultRows = truncated ? rows.slice(0, MAX_ROWS) : rows;
          const columns = resultRows.length > 0 ? Object.keys(resultRows[0]!) : [];

          return { action: 'query', rows: resultRows, columns };
        }

        case 'execute': {
          if (!input.sql) return { action: 'execute', error: 'sql is required for execute action' };
          const validationErr = validateSql(input.sql, 'execute');
          if (validationErr) return { action: 'execute', error: validationErr };

          const result = db.prepare(input.sql).run();
          return { action: 'execute', affected: result.changes };
        }

        default:
          return { action: input.action, error: `Unknown action: ${input.action}` };
      }
    } finally {
      db.close();
    }
  } catch (err) {
    return {
      action: input.action,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}
