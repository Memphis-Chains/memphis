import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';

import { hashWithSalt, saveOperatorConfig } from '../../src/infra/auth/operator-gate.js';
import { acknowledgeLegacyOperation, acknowledgeRecoveryTurn, listLegacyOperations, listRecoveryTurns, showRecoveryPartial } from '../../src/infra/runtime/turn-recovery.js';

const ID = 'a'.repeat(32);
const PASSWORD = 'synthetic-recovery-passphrase';
const SALT = 'synthetic-salt';
const PASSWORD_HASH = hashWithSalt(PASSWORD, SALT);

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
    expect(() => acknowledgeRecoveryTurn(file, ID, 'wrong')).toThrow(/authentication/);
    expect(listRecoveryTurns(file)).toHaveLength(1);
    acknowledgeRecoveryTurn(file, ID, PASSWORD);
    expect(listRecoveryTurns(file)).toEqual([]);
    expect(() => acknowledgeRecoveryTurn(file, ID, PASSWORD)).toThrow();
    const db = new Database(file, { readonly: true });
    expect(db.prepare('SELECT action, actor FROM operator_turn_recovery_audit').all())
      .toEqual([{ action: 'acknowledge', actor: 'local-operator' }]);
    expect(db.prepare('SELECT status, reviewed_at FROM operator_tool_operations WHERE id=?').get('unknown-op'))
      .toMatchObject({ status: 'unknown', reviewed_at: expect.any(String) });
    db.close();
  });

  it('refuses to acknowledge a possibly active turn without explicit force', () => {
    const file = fixture('running');
    expect(() => acknowledgeRecoveryTurn(file, ID, PASSWORD)).toThrow(/still running/);
    expect(listRecoveryTurns(file)).toHaveLength(1);
    acknowledgeRecoveryTurn(file, ID, PASSWORD, true);
    expect(listRecoveryTurns(file)).toEqual([]);
  });

  it('allows a reviewed blocked attempt to be cleared without forcing a running turn', () => {
    const file = fixture('blocked');
    acknowledgeRecoveryTurn(file, ID, PASSWORD);
    expect(listRecoveryTurns(file)).toEqual([]);
  });

  it('reviews a legacy unknown outcome without pretending its effect is known', () => {
    const file = fixture();
    const db = new Database(file);
    db.prepare('INSERT INTO operator_tool_operations VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run('legacy-id', 'session', null, 'memphis_exec', 'unknown', null, '2026-11-07');
    db.close();
    expect(listLegacyOperations(file)).toHaveLength(1);
    acknowledgeLegacyOperation(file, 'legacy-id', PASSWORD);
    expect(listLegacyOperations(file)).toHaveLength(0);
    const verify = new Database(file, { readonly: true });
    expect(verify.prepare('SELECT status, reviewed_at FROM operator_tool_operations WHERE id=?').get('legacy-id'))
      .toMatchObject({ status: 'unknown', reviewed_at: expect.any(String) });
    verify.close();
  });
});
