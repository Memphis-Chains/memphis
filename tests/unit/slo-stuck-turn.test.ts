import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { evaluateSlos } from '../../src/observability/slo-evaluator.js';
import {
  readRunningTurns,
  resolveOperatorDatabasePath,
} from '../../src/observability/stuck-turns.js';

// Measured 2026-11-11 on this host: `p99_turn_duration_ms` read
// `turn.dispatch` spans and failed at 9 002 810 ms against a
// 7 200 000 ms threshold. Two things were wrong with it.
//
// 1. The population was finished turns. `turn.dispatch` is written only
//    when a turn ENDS, so the metric measured the length of the
//    operator's working sessions — and the failing sample was a 2.5-hour
//    session that ran 211 tool calls, 206 of them successful, and ended
//    when the operator interrupted it. A long session is not a runtime
//    fault, so the metric was red by construction.
//
// 2. It could not see a hang AT ALL. A turn that never finishes writes
//    no `turn.dispatch` span. The host had an 18-hour-old turn the
//    runtime still believed was running: it wrote zero spans of any
//    kind, every span-based metric was blind to it, and the runtime
//    refused to start a new turn in that session.
//
// The runtime does know — `operator_turn_checkpoints` holds one row per
// turn with `status='running'` while it is in flight, and `updated_at`
// is refreshed after every assistant step and every tool result. These
// tests pin that behaviour.

function writeOperatorDatabase(
  path: string,
  rows: Array<{ id: string; status: string; updatedAt: string }>,
): void {
  const db = new Database(path);
  db.exec(`CREATE TABLE operator_turn_checkpoints (
    id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL,
    status TEXT NOT NULL,
    pending_json TEXT,
    partial_text TEXT,
    partial_truncated INTEGER,
    updated_at TEXT NOT NULL
  )`);
  const insert = db.prepare(
    'INSERT INTO operator_turn_checkpoints (id, session_id, status, pending_json, partial_text, partial_truncated, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
  );
  for (const row of rows) {
    insert.run(row.id, 'session-a', row.status, '[]', '', 0, row.updatedAt);
  }
  db.close();
}

describe('SLO · the turn that did not finish', () => {
  let dir: string;
  let databasePath: string;
  let rawEnv: NodeJS.ProcessEnv;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'memphis-stuck-turn-'));
    databasePath = join(dir, 'memphis.db');
    rawEnv = { ...process.env, DATABASE_URL: `file:${databasePath}`, MEMPHIS_DATA_DIR: dir };
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('reads the turns the runtime still believes are running', () => {
    const now = Date.parse('2026-11-11T12:00:00Z');
    writeOperatorDatabase(databasePath, [
      { id: 'a'.repeat(32), status: 'running', updatedAt: '2026-11-11T11:59:00Z' },
      { id: 'b'.repeat(32), status: 'running', updatedAt: '2026-11-10T18:00:00Z' },
      { id: 'c'.repeat(32), status: 'completed', updatedAt: '2026-11-11T10:00:00Z' },
      { id: 'd'.repeat(32), status: 'interrupted', updatedAt: '2026-11-11T10:00:00Z' },
    ]);

    const result = readRunningTurns(databasePath, now);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // Only `running` rows: an interrupted or completed turn is finished.
    expect(result.turns.map((turn) => turn.id)).toEqual(['b'.repeat(32), 'a'.repeat(32)]);
    // Sorted by idleness, oldest first.
    expect(result.turns[0].idleMs).toBe(18 * 60 * 60 * 1000);
    expect(result.turns[1].idleMs).toBe(60 * 1000);
  });

  it('reports a turn that has made no progress for hours as a failing SLO', () => {
    writeOperatorDatabase(databasePath, [
      { id: 'b'.repeat(32), status: 'running', updatedAt: '2026-11-09T12:00:00Z' },
    ]);

    const report = evaluateSlos({ rawEnv, now: new Date('2026-11-11T12:00:00Z') });
    const metric = report.slos.find((slo) => slo.name === 'p99_turn_duration_ms');
    expect(metric?.status).toBe('fail');
    expect(metric?.value).toBe(2 * 24 * 60 * 60 * 1000);
    // The reason names the turn, so the operator knows what to recover.
    expect(metric?.reason).toContain('b'.repeat(8));
  });

  it('passes when every running turn is making progress', () => {
    writeOperatorDatabase(databasePath, [
      { id: 'a'.repeat(32), status: 'running', updatedAt: '2026-11-11T11:59:30Z' },
    ]);

    const report = evaluateSlos({ rawEnv, now: new Date('2026-11-11T12:00:00Z') });
    const metric = report.slos.find((slo) => slo.name === 'p99_turn_duration_ms');
    expect(metric?.status).toBe('pass');
    expect(metric?.value).toBe(30 * 1000);
  });

  it('passes with a real zero when no turn is running', () => {
    writeOperatorDatabase(databasePath, [
      { id: 'c'.repeat(32), status: 'completed', updatedAt: '2026-11-11T10:00:00Z' },
    ]);

    const report = evaluateSlos({ rawEnv, now: new Date('2026-11-11T12:00:00Z') });
    const metric = report.slos.find((slo) => slo.name === 'p99_turn_duration_ms');
    // No turn in flight is a real zero, not missing evidence.
    expect(metric?.status).toBe('pass');
    expect(metric?.value).toBe(0);
    expect(metric?.reason).toContain('no turn is currently running');
  });

  it('is unavailable when the operator database cannot be read', () => {
    const report = evaluateSlos({
      rawEnv: { ...rawEnv, DATABASE_URL: `file:${join(dir, 'missing.db')}` },
      now: new Date('2026-11-11T12:00:00Z'),
    });
    const metric = report.slos.find((slo) => slo.name === 'p99_turn_duration_ms');
    // Missing evidence is not a pass.
    expect(metric?.status).toBe('unavailable');
    expect(metric?.reason).toContain('no operator database');
  });

  it('is unavailable when the database has no turn checkpoint table', () => {
    // The checkpoint table is created by the native runtime when the
    // first turn runs. Its absence means either that no turn ever ran or
    // that this is not the database the runtime uses — a path split.
    // Measured 2026-11-11: the stale copy of the operator database on
    // this host has no checkpoint table at all, and reporting a real zero
    // there would put a green light over a stuck turn.
    const db = new Database(databasePath);
    db.exec('CREATE TABLE sessions (id TEXT PRIMARY KEY)');
    db.close();

    const report = evaluateSlos({ rawEnv, now: new Date('2026-11-11T12:00:00Z') });
    const metric = report.slos.find((slo) => slo.name === 'p99_turn_duration_ms');
    expect(metric?.status).toBe('unavailable');
    expect(metric?.reason).toContain('no turn checkpoint table');
  });

  it('still reports the length of finished sessions as a diagnostic', () => {
    // The information the metric used to carry — how long the operator's
    // working sessions run — is not lost, it just stops being a verdict.
    const telemetryDir = join(dir, 'telemetry');
    mkdirSync(telemetryDir, { recursive: true });
    const spans = Array.from({ length: 20 }, () => ({
      ts: '2026-11-11T11:00:00Z',
      name: 'turn.dispatch',
      attrs: { 'turn.timing_ms': 9_000_000 },
      durationMs: 9_000_000,
      status: 'ok',
    }));
    writeFileSync(
      join(telemetryDir, 'spans-2026-11-11.jsonl'),
      `${spans.map((span) => JSON.stringify(span)).join('\n')}\n`,
      'utf8',
    );

    const report = evaluateSlos({ rawEnv, now: new Date('2026-11-11T12:00:00Z') });
    expect(report.turnDuration?.p99Ms).toBe(9_000_000);
    expect(report.turnDuration?.samples).toBe(20);
  });

  it('resolves the database path the way the recovery command does', () => {
    // A relative DATABASE_URL resolves against the install root, not the
    // current working directory — otherwise the same command would read
    // a different file depending on where it was started.
    expect(resolveOperatorDatabasePath({ DATABASE_URL: 'file:./data/memphis.db' })).toBe(
      resolveOperatorDatabasePath({
        DATABASE_URL: 'file:./data/memphis.db',
        MEMPHIS_RUNTIME_ROOT: process.cwd(),
      }),
    );
    // A non-file URL cannot be read as SQLite.
    expect(resolveOperatorDatabasePath({ DATABASE_URL: 'postgres://x' })).toBeNull();
  });
});
