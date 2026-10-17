import { spawnSync } from 'node:child_process';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';

import {
  commitConfigurationTransaction,
  configurationFileHash,
  recoverConfigurationTransaction,
  withConfigurationSnapshot,
  withConfigurationWriteLock,
} from '../../src/infra/config/config-transaction.js';

const roots: string[] = [];
afterEach(() => roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true })));
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'config-transaction-'));
  roots.push(root);
  const env = join(root, '.env');
  const state = join(root, 'vault-state.json');
  writeFileSync(env, 'old-env');
  writeFileSync(state, 'old-encrypted-state');
  return {
    env,
    state,
    updates: [
      { path: state, content: 'new-encrypted-state', expectedHash: configurationFileHash(state) },
      { path: env, content: 'new-env', expectedHash: configurationFileHash(env) },
    ],
  };
}
describe('durable multi-file configuration transaction', () => {
  it('reuses snapshot locks, rejects expansion and releases them after a reader fails', () => {
    const { env, state } = fixture();
    expect(() =>
      withConfigurationSnapshot(env, () => {
        expect(withConfigurationSnapshot(env, () => 'same snapshot')).toBe('same snapshot');
        expect(() => withConfigurationSnapshot([env, state], () => undefined)).toThrow(/expand/);
        expect(() => withConfigurationWriteLock(env, () => undefined)).toThrow(/Nested/);
        throw new Error('synthetic reader failure');
      }),
    ).toThrow('synthetic reader failure');
    withConfigurationWriteLock([env, state], () => {
      expect(withConfigurationSnapshot([state, env], () => 'reused writer')).toBe('reused writer');
    });
  });

  it.each(['dotenv', 'state'])(
    'recovers pending intent from the historical %s journal',
    (source) => {
      const { env, state, updates } = fixture();
      expect(() =>
        commitConfigurationTransaction(source === 'dotenv' ? env : state, updates, () => {
          throw new Error('interrupt');
        }),
      ).toThrow('interrupt');
      expect(recoverConfigurationTransaction([state, env])).toBe(true);
      expect(readFileSync(state, 'utf8')).toBe('new-encrypted-state');
      expect(readFileSync(env, 'utf8')).toBe('new-env');
      expect(recoverConfigurationTransaction([state, env])).toBe(false);
    },
  );

  it('uses the designated primary for intent while holding every compatibility lock', () => {
    const { env, state, updates } = fixture();
    expect(() =>
      commitConfigurationTransaction([state, env], updates, () => {
        throw new Error('interrupt');
      }),
    ).toThrow('interrupt');
    for (const [base, expected] of [
      [state, 1],
      [env, 0],
    ] as const) {
      const db = new Database(join(`${base}.transactions`, 'journal.sqlite'));
      expect(
        db.prepare("SELECT COUNT(*) AS count FROM transactions WHERE status = 'prepared'").get(),
      ).toEqual({ count: expected });
      db.close();
    }
    expect(recoverConfigurationTransaction([state, env])).toBe(true);
    withConfigurationWriteLock([state, env], () => {
      expect(recoverConfigurationTransaction([env, state])).toBe(false);
      for (const base of [state, env]) {
        const db = new Database(join(`${base}.transactions`, 'journal.sqlite'));
        db.pragma('busy_timeout = 0');
        try {
          expect(() => db.exec('BEGIN IMMEDIATE')).toThrow(/locked/);
        } finally {
          db.close();
        }
      }
    });
  });

  it('deduplicates symlink aliases and rejects expansion of a held lock set', () => {
    const { env, state } = fixture();
    const aliasRoot = join(dirname(env), 'alias');
    symlinkSync(dirname(env), aliasRoot, 'dir');
    const alias = join(aliasRoot, '.env');
    withConfigurationWriteLock([env, alias], () => {
      expect(recoverConfigurationTransaction([alias, env])).toBe(false);
      expect(() => recoverConfigurationTransaction([env, state])).toThrow(/expand/);
      expect(() => withConfigurationWriteLock(alias, () => undefined)).toThrow(/Nested/);
    });
    expect(recoverConfigurationTransaction([env, alias])).toBe(false);
  });

  it('refuses ambiguous pending generations before publishing either journal', () => {
    const { env, state, updates } = fixture();
    expect(() =>
      commitConfigurationTransaction(env, updates, () => {
        throw new Error('interrupt');
      }),
    ).toThrow('interrupt');
    writeFileSync(state, 'old-encrypted-state');
    writeFileSync(env, 'old-env');
    mkdirSync(`${state}.transactions`);
    const legacy = new Database(join(`${state}.transactions`, 'journal.sqlite'));
    legacy.exec(
      'CREATE TABLE transactions (id INTEGER PRIMARY KEY, status TEXT NOT NULL, updates TEXT NOT NULL, previous TEXT NOT NULL, created_at TEXT NOT NULL)',
    );
    legacy
      .prepare(
        "INSERT INTO transactions(status, updates, previous, created_at) VALUES ('prepared', ?, '[]', 'fixture')",
      )
      .run(JSON.stringify(updates));
    legacy.close();
    expect(() => recoverConfigurationTransaction([state, env])).toThrow(
      /multiple configuration journals/,
    );
    expect(readFileSync(state, 'utf8')).toBe('old-encrypted-state');
    expect(readFileSync(env, 'utf8')).toBe('old-env');
    for (const base of [env, state]) {
      const db = new Database(join(`${base}.transactions`, 'journal.sqlite'));
      db.pragma('busy_timeout = 0');
      db.exec('BEGIN IMMEDIATE; ROLLBACK');
      db.close();
    }
  });

  it('allows recovery reads under the writer lock and releases ownership after failure', () => {
    const { env, updates } = fixture();
    expect(() =>
      withConfigurationWriteLock(env, () => {
        expect(recoverConfigurationTransaction(env)).toBe(false);
        expect(() => commitConfigurationTransaction(env, updates)).toThrow(
          /inside a write callback/,
        );
        expect(() => withConfigurationWriteLock(env, () => undefined)).toThrow(/Nested/);
        throw new Error('synthetic callback failure');
      }),
    ).toThrow('synthetic callback failure');
    commitConfigurationTransaction(env, updates);
    expect(recoverConfigurationTransaction(env)).toBe(false);
  });
  it.each([0, 1])('recovers interruption after publication %s idempotently', (interruptAfter) => {
    const { env, state, updates } = fixture();
    expect(() =>
      commitConfigurationTransaction(env, updates, (index) => {
        if (index === interruptAfter) throw new Error('simulated process failure');
      }),
    ).toThrow();
    expect(recoverConfigurationTransaction(env)).toBe(true);
    expect(readFileSync(env, 'utf8')).toBe('new-env');
    expect(readFileSync(state, 'utf8')).toBe('new-encrypted-state');
    expect(recoverConfigurationTransaction(env)).toBe(false);
    expect(statSync(`${env}.transactions`).mode & 0o777).toBe(0o700);
    expect(statSync(join(`${env}.transactions`, 'journal.sqlite')).mode & 0o777).toBe(0o600);
  });
  it('recovers a real process exit after the first file publication', () => {
    const { env, state, updates } = fixture();
    const child = spawnSync(
      process.execPath,
      [
        '--import',
        'tsx',
        '--input-type=module',
        '-e',
        `
      import { commitConfigurationTransaction } from './src/infra/config/config-transaction.ts';
      commitConfigurationTransaction(process.argv[1], JSON.parse(process.argv[2]), () => process.exit(74));
    `,
        env,
        JSON.stringify(updates),
      ],
      { encoding: 'utf8' },
    );
    expect(child.status).toBe(74);
    expect(readFileSync(env, 'utf8')).toBe('old-env');
    expect(readFileSync(state, 'utf8')).toBe('new-encrypted-state');
    expect(recoverConfigurationTransaction(env)).toBe(true);
    expect(readFileSync(env, 'utf8')).toBe('new-env');
  });

  it('refuses concurrent external edits before any publication', () => {
    const { env, state, updates } = fixture();
    writeFileSync(env, 'external-edit');
    expect(() => commitConfigurationTransaction(env, updates)).toThrow(/changed/);
    expect(readFileSync(state, 'utf8')).toBe('old-encrypted-state');
  });
  it('does not overwrite an unrelated edit during recovery', () => {
    const { env, updates } = fixture();
    expect(() =>
      commitConfigurationTransaction(env, updates, () => {
        throw new Error('interrupt');
      }),
    ).toThrow();
    writeFileSync(env, 'external-edit');
    expect(() => recoverConfigurationTransaction(env)).toThrow(/outside pending transaction/);
    expect(readFileSync(env, 'utf8')).toBe('external-edit');
  });
  it.each([0, 1])('recovers SIGKILL after publication %s in a fresh process', (interruptAfter) => {
    const { env, state, updates } = fixture();
    const child = spawnSync(
      process.execPath,
      [
        '--import',
        'tsx',
        '--input-type=module',
        '-e',
        `
      import { commitConfigurationTransaction } from './src/infra/config/config-transaction.ts';
      commitConfigurationTransaction(process.argv[1], JSON.parse(process.argv[2]), (index) => {
        if (index === Number(process.argv[3])) process.kill(process.pid, 'SIGKILL');
      });
    `,
        env,
        JSON.stringify(updates),
        String(interruptAfter),
      ],
      { encoding: 'utf8', timeout: 15000 },
    );
    expect(child.signal).toBe('SIGKILL');
    const recovery = spawnSync(
      process.execPath,
      [
        '--import',
        'tsx',
        '--input-type=module',
        '-e',
        `
      import { recoverConfigurationTransaction } from './src/infra/config/config-transaction.ts';
      if (!recoverConfigurationTransaction(process.argv[1])) process.exit(2);
      if (recoverConfigurationTransaction(process.argv[1])) process.exit(3);
    `,
        env,
      ],
      { encoding: 'utf8', timeout: 15000 },
    );
    expect(recovery.status, recovery.stderr).toBe(0);
    expect(readFileSync(state, 'utf8')).toBe('new-encrypted-state');
    expect(readFileSync(env, 'utf8')).toBe('new-env');
  });

  it('checks later conflicts before republishing an earlier recoverable file', () => {
    const { env, state, updates } = fixture();
    expect(() =>
      commitConfigurationTransaction(env, updates, () => {
        throw new Error('interrupt');
      }),
    ).toThrow();
    writeFileSync(state, 'old-encrypted-state');
    writeFileSync(env, 'external-edit');
    expect(() => recoverConfigurationTransaction(env)).toThrow(/outside pending transaction/);
    expect(readFileSync(state, 'utf8')).toBe('old-encrypted-state');
    expect(readFileSync(env, 'utf8')).toBe('external-edit');
  });

  it('rejects duplicate targets expressed through lexical path aliases', () => {
    const { env, state, updates } = fixture();
    const alias = { ...updates[0], path: `${state}/../vault-state.json` };
    expect(() => commitConfigurationTransaction(env, [updates[0], alias])).toThrow(
      /Invalid configuration/,
    );
    expect(readFileSync(state, 'utf8')).toBe('old-encrypted-state');
  });

  it('rejects a stale writer after another transaction commits', () => {
    const { env, state, updates } = fixture();
    commitConfigurationTransaction(env, updates);
    expect(() => commitConfigurationTransaction(env, updates)).toThrow(
      /changed during preparation/,
    );
    expect(readFileSync(state, 'utf8')).toBe('new-encrypted-state');
    expect(readFileSync(env, 'utf8')).toBe('new-env');
  });
  it('recovers durable intent before the first target publication', () => {
    const { env, state, updates } = fixture();
    // Seed the exact on-disk phase left after journal commit, before publishing
    // any target. A fresh recovery must not require an in-memory writer.
    commitConfigurationTransaction(env, updates);
    writeFileSync(state, 'old-encrypted-state');
    writeFileSync(env, 'old-env');
    const db = new Database(join(`${env}.transactions`, 'journal.sqlite'));
    try {
      db.prepare("UPDATE transactions SET status = 'prepared'").run();
    } finally {
      db.close();
    }
    expect(recoverConfigurationTransaction(env)).toBe(true);
    expect(readFileSync(state, 'utf8')).toBe('new-encrypted-state');
    expect(readFileSync(env, 'utf8')).toBe('new-env');
    expect(recoverConfigurationTransaction(env)).toBe(false);
  });
});
