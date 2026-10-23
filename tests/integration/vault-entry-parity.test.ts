import { spawnSync } from 'node:child_process';
import { createCipheriv, createHash } from 'node:crypto';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { resetActiveVault, vaultDecrypt } from '../../src/infra/storage/rust-vault-adapter.js';
import {
  deleteVaultEntriesByKey,
  getLatestVaultEntry,
  listVaultEntries,
} from '../../src/infra/storage/vault-entry-store.js';
import { createIsolatedTestRuntime } from '../helpers/isolated-runtime.js';

const roots: string[] = [];
afterEach(() => {
  resetActiveVault();
  roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true }));
});
const reader = resolve(
  process.env.CARGO_TARGET_DIR ?? 'target',
  'debug/examples/vault-read-fixture',
);
function fingerprint(entry: { key: string; encrypted: string; iv: string }) {
  return createHash('sha256')
    .update(JSON.stringify({ key: entry.key, encrypted: entry.encrypted, iv: entry.iv }))
    .digest('hex');
}
function encrypted(
  key = 'first',
  plaintext: string | Buffer = 'synthetic-first-credential',
  master = Buffer.alloc(32, 2),
) {
  const iv = Buffer.alloc(12, 3);
  const cipher = createCipheriv('aes-256-gcm', master, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const entry = {
    key,
    encrypted: encrypted.toString('base64'),
    iv: iv.toString('base64'),
    tag: cipher.getAuthTag().toString('base64'),
    createdAt: '2026-10-17T00:00:00Z',
  };
  return { ...entry, fingerprint: fingerprint(entry) };
}
function fixture(entries: unknown = [encrypted()]) {
  const fixture = createIsolatedTestRuntime(process.env, resolve('.'));
  roots.push(fixture.root);
  delete fixture.env.MEMPHIS_VAULT_PEPPER;
  writeFileSync(
    fixture.env.MEMPHIS_VAULT_STATE_PATH!,
    JSON.stringify({
      salt: Buffer.alloc(32, 1).toString('base64'),
      masterKey: Buffer.alloc(32, 2).toString('base64'),
    }),
  );
  writeFileSync(fixture.env.MEMPHIS_VAULT_ENTRIES_PATH!, JSON.stringify(entries));
  return fixture;
}
function native(env: NodeJS.ProcessEnv, key = 'first', expected = 'synthetic-first-credential') {
  return spawnSync(reader, [], {
    env: { ...env, MEMPHIS_FIXTURE_VAULT_KEY: key, MEMPHIS_FIXTURE_VAULT_EXPECTED: expected },
    encoding: 'utf8',
    timeout: 15000,
  });
}
function assertReadable(
  env: NodeJS.ProcessEnv,
  key = 'first',
  expected = 'synthetic-first-credential',
) {
  const entry = getLatestVaultEntry(key, env);
  expect(entry).toBeDefined();
  expect(vaultDecrypt(entry!, env)).toBe(expected);
  const result = native(env, key, expected);
  expect(result.status, result.stderr).toBe(0);
}

describe('shared stored vault entry contract', () => {
  it.each(['first', 'quoted"\\\nkey', 'żółć🔑\u2028key'])(
    'matches JS fingerprint escaping for %j',
    (key) => {
      const f = fixture([encrypted(key)]);
      assertReadable(f.env, key);
    },
  );
  it('preserves BOM in a valid UTF-8 credential', () => {
    const secret = '\uFEFFsynthetic-first-credential';
    const f = fixture([encrypted('first', secret)]);
    assertReadable(f.env, 'first', secret);
  });
  it('selects append order instead of the newest timestamp', () => {
    const old = { ...encrypted('first', 'synthetic-old'), createdAt: '2099-01-01T00:00:00Z' };
    const f = fixture([old, encrypted()]);
    assertReadable(f.env);
  });
  it('reads legacy combined tags and missing metadata without rewriting the file', () => {
    const entry = encrypted();
    const legacy = {
      key: entry.key,
      iv: entry.iv,
      encrypted: Buffer.concat([
        Buffer.from(entry.encrypted, 'base64'),
        Buffer.from(entry.tag, 'base64'),
      ]).toString('base64'),
    };
    const f = fixture([legacy]);
    const before = readFileSync(f.env.MEMPHIS_VAULT_ENTRIES_PATH!);
    assertReadable(f.env);
    expect(readFileSync(f.env.MEMPHIS_VAULT_ENTRIES_PATH!)).toEqual(before);
  });
  it('preserves extension metadata when another key is deleted', () => {
    const f = fixture([{ ...encrypted(), custom: { retained: ['value', 1] } }, encrypted('other')]);
    deleteVaultEntriesByKey('other', f.env);
    const entries = JSON.parse(readFileSync(f.env.MEMPHIS_VAULT_ENTRIES_PATH!, 'utf8'));
    expect(entries[0].custom).toEqual({ retained: ['value', 1] });
    assertReadable(f.env);
  });
  it.each(['', '{private-sentinel', '{}', '[null]', '[{"key":123}]'])(
    'rejects malformed stores without returning an empty vault: %j',
    (raw) => {
      const f = fixture();
      writeFileSync(f.env.MEMPHIS_VAULT_ENTRIES_PATH!, raw);
      expect(() => listVaultEntries(f.env)).toThrow('VAULT_ENTRIES_MALFORMED');
      const result = native(f.env);
      expect(result.status).toBe(3);
      expect(result.stderr).toContain('VAULT_ENTRIES_MALFORMED');
      expect(result.stderr).not.toContain('private-sentinel');
      expect(readFileSync(f.env.MEMPHIS_VAULT_ENTRIES_PATH!, 'utf8')).toBe(raw);
    },
  );
  it.each(['directory', 'invalid-utf8'])('classifies unreadable %s consistently', (kind) => {
    const f = fixture();
    const path = f.env.MEMPHIS_VAULT_ENTRIES_PATH!;
    if (kind === 'directory') {
      rmSync(path);
      mkdirSync(path);
    } else writeFileSync(path, Buffer.from([0xff]));
    expect(() => listVaultEntries(f.env)).toThrow('VAULT_ENTRIES_UNREADABLE');
    const result = native(f.env);
    expect(result.status).toBe(3);
    expect(result.stderr).toContain('VAULT_ENTRIES_UNREADABLE');
  });
  it.each([
    ['fingerprint', 'VAULT_ENTRY_INTEGRITY_FAILED'],
    ['nonce', 'VAULT_ENTRIES_MALFORMED'],
    ['tag', 'VAULT_ENTRIES_MALFORMED'],
    ['base64', 'VAULT_ENTRIES_MALFORMED'],
    ['authentication', 'VAULT_ENTRY_AUTH_FAILED'],
    ['text', 'VAULT_ENTRY_INVALID_TEXT'],
  ])('rejects the latest %s error without falling back to an older key', (kind, code) => {
    const bad =
      kind === 'authentication'
        ? encrypted('first', 'synthetic-first-credential', Buffer.alloc(32, 7))
        : kind === 'text'
          ? encrypted('first', Buffer.from([0xff]))
          : encrypted();
    if (kind === 'nonce') bad.iv = Buffer.alloc(3).toString('base64');
    if (kind === 'tag') bad.tag = Buffer.alloc(3).toString('base64');
    if (kind === 'base64') bad.encrypted = 'private-sentinel';
    bad.fingerprint = kind === 'fingerprint' ? 'private-sentinel' : fingerprint(bad);
    const f = fixture([encrypted(), bad]);
    expect(() => vaultDecrypt(getLatestVaultEntry('first', f.env)!, f.env)).toThrow(code);
    const result = native(f.env);
    expect(result.status).toBe(3);
    expect(result.stderr).toContain(code);
    expect(result.stderr).not.toContain('private-sentinel');
  });
  it.each(['missing', 'empty'])('treats a %s store as no entries', (kind) => {
    const f = fixture([]);
    if (kind === 'missing') rmSync(f.env.MEMPHIS_VAULT_ENTRIES_PATH!);
    expect(getLatestVaultEntry('first', f.env)).toBeUndefined();
    const result = native(f.env);
    expect(result.status).toBe(3);
    expect(result.stderr).toContain('VAULT_ENTRY_NOT_FOUND');
  });
});
