import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';

import { hashWithSalt, saveOperatorConfig } from '../../src/infra/auth/operator-gate.js';
import { acknowledgeLegacyOperation, acknowledgeRecoveryTurn, listLegacyOperations, listRecoveryTurns, showRecoveryPartial } from '../../src/infra/runtime/turn-recovery.js';
import { requestTier3Elevation } from '../../src/security/tier3-session.js';

const ID = 'a'.repeat(32);
const PASSWORD = 'synthetic-recovery-passphrase';
const SALT = 'synthetic-salt';
const PASSWORD_HASH = hashWithSalt(PASSWORD, SALT);
/** The CLI's authority: the operator typed the passphrase. */
const PASSPHRASE_AUTHORITY = { kind: 'passphrase', passphrase: PASSWORD } as const;

function fixture(status: 'running' | 'interrupted' | 'blocked' = 'interrupted'): string {
  const root = mkdtempSync(join(tmpdir(), 'memphis-recovery-test-'));
  process.env.MEMPHIS_DATA_DIR = root;
  saveOperatorConfig({ schemaVersion: 1, passphraseHash: PASSWORD_HASH, salt: SALT,
    createdAt: '', updatedAt: '', recoveryQuestionHint: '', recoveryHash: '' });
  const file = join(root, 'state.db');
  const db = new Database(file);
  db.exec(`CREATE TABLE operator_turn_checkpoints (id TEXT PRIMARY KEY, session_id TEXT, status TEXT, pending_json TEXT, partial_text TEXT, partial_truncated INTEGER, updated_at TEXT);
           CREATE TABLE operator_tool_operations (id TEXT, session_id TEXT, turn_id TEXT, tool_name TEXT, status TEXT, result_summary TEXT, created_at TEXT);`);
  db.prepare('INSERT INTO operator_turn_checkpoints VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(ID, 'session', status, '[{"private":"do-not-display"}]', 'visible partial', 1, '2026-11-07');
  db.prepare('INSERT INTO operator_tool_operations VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run('op', 'session', ID, 'memphis_exec', 'completed', 'exit=7', '2026-11-07');
  db.close();
  return file;
}

describe('interrupted turn recovery', () => {
  it('shows metadata and exit status without exposing checkpoint payloads', () => {
    const turns = listRecoveryTurns(fixture());
    expect(turns).toHaveLength(1);
    expect(turns[0].operations).toEqual([{ tool: 'memphis_exec', status: 'completed', exitCode: 7 }]);
    expect(JSON.stringify(turns)).not.toContain('do-not-display');
    expect(JSON.stringify(turns)).not.toContain('visible partial');
    expect(showRecoveryPartial(fixture(), ID)).toEqual({ text: 'visible partial', truncated: true });
  });

  it('acknowledges only once and records an audit in the same transaction', () => {
    const file = fixture();
    const before = new Database(file);
    before.prepare('INSERT INTO operator_tool_operations VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run('unknown-op', 'session', ID, 'memphis_exec', 'unknown', null, '2026-11-07');
    before.close();
    expect(() => acknowledgeRecoveryTurn(file, ID, { kind: 'passphrase', passphrase: 'wrong' })).toThrow(/authentication/);
    expect(listRecoveryTurns(file)).toHaveLength(1);
    acknowledgeRecoveryTurn(file, ID, PASSPHRASE_AUTHORITY);
    expect(listRecoveryTurns(file)).toEqual([]);
    expect(() => acknowledgeRecoveryTurn(file, ID, PASSPHRASE_AUTHORITY)).toThrow();
    const db = new Database(file, { readonly: true });
    expect(db.prepare('SELECT action, actor FROM operator_turn_recovery_audit').all())
      .toEqual([{ action: 'acknowledge', actor: 'local-operator' }]);
    expect(db.prepare('SELECT status, reviewed_at FROM operator_tool_operations WHERE id=?').get('unknown-op'))
      .toMatchObject({ status: 'unknown', reviewed_at: expect.any(String) });
    db.close();
  });

  it('refuses to acknowledge a possibly active turn without explicit force', () => {
    const file = fixture('running');
    expect(() => acknowledgeRecoveryTurn(file, ID, PASSPHRASE_AUTHORITY)).toThrow(/still running/);
    expect(listRecoveryTurns(file)).toHaveLength(1);
    acknowledgeRecoveryTurn(file, ID, PASSPHRASE_AUTHORITY, true);
    expect(listRecoveryTurns(file)).toEqual([]);
  });

  it('allows a reviewed blocked attempt to be cleared without forcing a running turn', () => {
    const file = fixture('blocked');
    acknowledgeRecoveryTurn(file, ID, PASSPHRASE_AUTHORITY);
    expect(listRecoveryTurns(file)).toEqual([]);
  });

  /**
   * The cockpit's authority is a TIER-3 SESSION, and the owner checks it.
   *
   * The cockpit is where the wedge happens — the turn is refused there —
   * so the escape has to be reachable there too. It is reachable with the
   * authority the cockpit already holds: `/tier 3 <passphrase>` mints a
   * session, and the session expires on its own. The gate: a DEAD session
   * is refused exactly like a wrong passphrase, and the owner is the one
   * that refuses it.
   */
  it('accepts the cockpit\'s own authority — a live tier-3 session — and refuses a dead one', () => {
    const file = fixture();
    const previousHome = process.env.MEMPHIS_HOME;
    // The tier-3 session is persisted under MEMPHIS_HOME; point it at the
    // fixture so the test never touches the operator's home.
    process.env.MEMPHIS_HOME = dirname(file);
    try {
      expect(() =>
        acknowledgeRecoveryTurn(file, ID, { kind: 'elevated-session', surface: 'tui', actorId: 'local' }),
      ).toThrow(/tier-3/);
      expect(listRecoveryTurns(file)).toHaveLength(1);

      const elevation = requestTier3Elevation({ surface: 'tui', actorId: 'local', passphrase: PASSWORD });
      expect(elevation.ok).toBe(true);

      acknowledgeRecoveryTurn(file, ID, { kind: 'elevated-session', surface: 'tui', actorId: 'local' });
      expect(listRecoveryTurns(file)).toEqual([]);
    } finally {
      if (previousHome === undefined) delete process.env.MEMPHIS_HOME;
      else process.env.MEMPHIS_HOME = previousHome;
    }
  });

  it('reviews a legacy unknown outcome without pretending its effect is known', () => {
    const file = fixture();
    const db = new Database(file);
    db.prepare('INSERT INTO operator_tool_operations VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run('legacy-id', 'session', null, 'memphis_exec', 'unknown', null, '2026-11-07');
    db.close();
    expect(listLegacyOperations(file)).toHaveLength(1);
    acknowledgeLegacyOperation(file, 'legacy-id', PASSPHRASE_AUTHORITY);
    expect(listLegacyOperations(file)).toHaveLength(0);
    const verify = new Database(file, { readonly: true });
    expect(verify.prepare('SELECT status, reviewed_at FROM operator_tool_operations WHERE id=?').get('legacy-id'))
      .toMatchObject({ status: 'unknown', reviewed_at: expect.any(String) });
    verify.close();
  });
});

/**
 * The recovery list and the recovery guard must agree.
 *
 * Measured 2026-11-22 on this host: `memphis recovery list` reported 46
 * turns to acknowledge, while the Rust console — the authoritative
 * operator cockpit — armed its guard on 15. The difference was 31 turns
 * that had NOTHING outstanding: a turn that failed without dispatching a
 * tool cannot have left a half-applied side effect.
 *
 * Two surfaces with two definitions of "unfinished work" is the shape
 * this repository already has a postmortem about. The narrow definition
 * is the Rust one (`list_recovery_turns` in
 * crates/memphis-operator/src/chat_session.rs), and it is the only signal
 * that measures a possible side effect.
 */
describe('the recovery list asks for a decision only where there is one', () => {
  function fixtureWithOperations(
    operations: Array<{ id: string; status: string; reviewed?: string }>,
  ): string {
    const root = mkdtempSync(join(tmpdir(), 'memphis-recovery-parity-'));
    process.env.MEMPHIS_DATA_DIR = root;
    saveOperatorConfig({ schemaVersion: 1, passphraseHash: PASSWORD_HASH, salt: SALT,
      createdAt: '', updatedAt: '', recoveryQuestionHint: '', recoveryHash: '' });
    const file = join(root, 'state.db');
    const db = new Database(file);
    db.exec(`CREATE TABLE operator_turn_checkpoints (id TEXT PRIMARY KEY, session_id TEXT, status TEXT, pending_json TEXT, partial_text TEXT, partial_truncated INTEGER, updated_at TEXT);
             CREATE TABLE operator_tool_operations (id TEXT, session_id TEXT, turn_id TEXT, tool_name TEXT, status TEXT, result_summary TEXT, created_at TEXT, reviewed_at TEXT);`);
    db.prepare('INSERT INTO operator_turn_checkpoints VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(ID, 'session', 'interrupted', '[]', '', 0, '2026-11-07');
    for (const operation of operations) {
      db.prepare('INSERT INTO operator_tool_operations VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
        .run(operation.id, 'session', ID, 'memphis_exec', operation.status, null, '2026-11-07', operation.reviewed ?? null);
    }
    db.close();
    return file;
  }

  it('asks for a decision when an operation was dispatched and never settled', () => {
    const turns = listRecoveryTurns(fixtureWithOperations([{ id: 'op-1', status: 'unknown' }]));
    expect(turns).toHaveLength(1);
    expect(turns[0].unsettledCount).toBe(1);
    expect(turns[0].needsAcknowledgement).toBe(true);
  });

  it('does NOT ask for a decision when every operation settled', () => {
    const turns = listRecoveryTurns(fixtureWithOperations([
      { id: 'op-1', status: 'completed' },
      { id: 'op-2', status: 'failed' },
    ]));
    expect(turns[0].unsettledCount).toBe(0);
    expect(turns[0].needsAcknowledgement).toBe(false);
  });

  it('does NOT ask for a decision for an operation the operator already reviewed', () => {
    const turns = listRecoveryTurns(fixtureWithOperations([
      { id: 'op-1', status: 'unknown', reviewed: '2026-11-08T00:00:00.000Z' },
    ]));
    expect(turns[0].unsettledCount).toBe(0);
    expect(turns[0].needsAcknowledgement).toBe(false);
  });

  it('counts a started operation as unsettled', () => {
    const turns = listRecoveryTurns(fixtureWithOperations([{ id: 'op-1', status: 'started' }]));
    expect(turns[0].needsAcknowledgement).toBe(true);
  });
});
