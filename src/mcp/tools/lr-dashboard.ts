import { existsSync, mkdirSync, chmodSync } from 'node:fs';
import path from 'node:path';

import Database from 'better-sqlite3';
import { z } from 'zod';

import { getDataDir } from '../../config/paths.js';

const entrySchema = z.object({
  measuredAt: z.string().trim().min(1).max(64),
  category: z.string().trim().min(1).max(80),
  marker: z.string().trim().min(1).max(120),
  value: z.string().trim().min(1).max(80),
  unit: z.string().trim().max(40).optional().default(''),
  note: z.string().trim().max(2000).optional().default(''),
});

export const lrDashboardToolInputSchema = z
  .object({
    action: z.enum(['status', 'add_entry']).default('status'),
    measuredAt: z.string().trim().min(1).max(64).optional(),
    category: z.string().trim().min(1).max(80).optional(),
    marker: z.string().trim().min(1).max(120).optional(),
    value: z.string().trim().min(1).max(80).optional(),
    unit: z.string().trim().max(40).optional(),
    note: z.string().trim().max(2000).optional(),
    approval_request_id: z.string().optional(),
  })
  .strict();

export type LrDashboardToolInput = z.infer<typeof lrDashboardToolInputSchema>;

function resolveLrDashboardPaths(rawEnv: NodeJS.ProcessEnv = process.env): {
  appRoot: string;
  stateDir: string;
  dbPath: string;
} {
  const appRoot = path.join(getDataDir(rawEnv), 'apps', 'lr-dashboard');
  const stateDir = rawEnv.LR_DASHBOARD_STATE_DIR || path.join(appRoot, 'state');
  const dbPath = rawEnv.LR_DASHBOARD_DB_PATH || rawEnv.LR_DB_PATH || path.join(stateDir, 'lr.sqlite');
  return { appRoot, stateDir, dbPath };
}

function ensureDb(dbPath: string): Database.Database {
  mkdirSync(path.dirname(dbPath), { recursive: true, mode: 0o700 });
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.exec(`
    CREATE TABLE IF NOT EXISTS entries (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      measured_at TEXT NOT NULL,
      category TEXT NOT NULL,
      marker TEXT NOT NULL,
      value TEXT NOT NULL,
      unit TEXT NOT NULL DEFAULT '',
      note TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_entries_measured_at ON entries(measured_at DESC);
    CREATE INDEX IF NOT EXISTS idx_entries_marker ON entries(marker);
  `);
  try {
    chmodSync(dbPath, 0o600);
    chmodSync(path.dirname(dbPath), 0o700);
  } catch {
    // Best-effort permission tightening for non-POSIX hosts.
  }
  return db;
}

function rowToEntry(row: {
  id: number;
  measured_at: string;
  category: string;
  marker: string;
  value: string;
  unit: string;
  note: string;
  created_at: string;
  updated_at: string;
}) {
  return {
    id: row.id,
    measuredAt: row.measured_at,
    category: row.category,
    marker: row.marker,
    value: row.value,
    unit: row.unit,
    note: row.note,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function runMemphisLrDashboard(
  input: LrDashboardToolInput,
  rawEnv: NodeJS.ProcessEnv = process.env,
):
  | {
      ok: true;
      action: 'status';
      appRoot: string;
      stateDir: string;
      dbPath: string;
      dbExists: boolean;
      entries: number | null;
    }
  | {
      ok: true;
      action: 'add_entry';
      appRoot: string;
      stateDir: string;
      dbPath: string;
      entry: ReturnType<typeof rowToEntry>;
    } {
  const parsed = lrDashboardToolInputSchema.parse(input);
  const paths = resolveLrDashboardPaths(rawEnv);

  if (parsed.action === 'status') {
    let entries: number | null = null;
    if (existsSync(paths.dbPath)) {
      const db = ensureDb(paths.dbPath);
      try {
        const row = db.prepare('SELECT COUNT(*) AS count FROM entries').get() as
          | { count: number }
          | undefined;
        entries = row?.count ?? null;
      } finally {
        db.close();
      }
    }
    return {
      ok: true,
      action: 'status',
      ...paths,
      dbExists: existsSync(paths.dbPath),
      entries,
    };
  }

  const entry = entrySchema.parse({
    measuredAt: parsed.measuredAt,
    category: parsed.category,
    marker: parsed.marker,
    value: parsed.value,
    unit: parsed.unit,
    note: parsed.note,
  });
  const db = ensureDb(paths.dbPath);
  try {
    const result = db
      .prepare(
        `
          INSERT INTO entries (measured_at, category, marker, value, unit, note)
          VALUES (@measuredAt, @category, @marker, @value, @unit, @note)
        `,
      )
      .run(entry);
    const row = db.prepare('SELECT * FROM entries WHERE id = ?').get(result.lastInsertRowid) as
      | Parameters<typeof rowToEntry>[0]
      | undefined;
    if (!row) throw new Error('lr-dashboard insert succeeded but row could not be re-read');
    return {
      ok: true,
      action: 'add_entry',
      ...paths,
      entry: rowToEntry(row),
    };
  } finally {
    db.close();
  }
}
