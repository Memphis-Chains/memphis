import { spawnSync } from 'node:child_process';
import { createCipheriv, createHash, scryptSync } from 'node:crypto';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { resetActiveVault, vaultDecrypt } from '../../src/infra/storage/rust-vault-adapter.js';
import { readVaultSecretByKey } from '../../src/security/vault-boundary.js';
import { createIsolatedTestRuntime } from '../helpers/isolated-runtime.js';

const roots: string[] = [];
afterEach(() => {
  resetActiveVault();
  roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true }));
});
const golden = JSON.parse(readFileSync('tests/fixtures/vault-state-v2.synthetic.json', 'utf8'));
const pepper = 'synthetic-state-reader-pepper';
const reader = resolve(
  process.env.CARGO_TARGET_DIR ?? 'target',
  'debug/examples/vault-read-fixture',
);
const bridge = createRequire(import.meta.url)(process.env.RUST_CHAIN_BRIDGE_PATH!);

function fixture(state: unknown = golden) {
  const fixture = createIsolatedTestRuntime(process.env, resolve('.'));
  roots.push(fixture.root);
  fixture.env.MEMPHIS_VAULT_PEPPER = pepper;
  if (state !== undefined)
    writeFileSync(fixture.env.MEMPHIS_VAULT_STATE_PATH!, JSON.stringify(state));
  const iv = Buffer.alloc(12, 4);
  const cipher = createCipheriv('aes-256-gcm', Buffer.alloc(32, 2), iv);
  const encrypted = Buffer.concat([cipher.update('synthetic-first-credential'), cipher.final()]);
  const entry = {
    key: 'first',
    encrypted: encrypted.toString('base64'),
    iv: iv.toString('base64'),
    id: 'synthetic-entry',
    tag: cipher.getAuthTag().toString('base64'),
    createdAt: '2026-10-16T00:00:00.000Z',
  };
  const fingerprint = createHash('sha256')
    .update(JSON.stringify({ key: entry.key, encrypted: entry.encrypted, iv: entry.iv }))
    .digest('hex');
  writeFileSync(
    fixture.env.MEMPHIS_VAULT_ENTRIES_PATH!,
    JSON.stringify([{ ...entry, fingerprint }]),
  );
  return { ...fixture, entry };
}

function native(env: NodeJS.ProcessEnv) {
  return spawnSync(reader, [], { env, encoding: 'utf8', timeout: 30000 });
}

describe('shared Rust vault state contract through TS/NAPI and native', () => {
  it('reads the same Node v2 fixture without changing it', () => {
    const f = fixture();
    f.env.MEMPHIS_VAULT_PEPPER = ` \uFEFF${pepper}\uFEFF\n`;
    const before = readFileSync(f.env.MEMPHIS_VAULT_STATE_PATH!);
    const result = native(f.env);
    expect(result.status, result.stderr).toBe(0);
    expect(vaultDecrypt(f.entry, f.env)).toBe('synthetic-first-credential');
    expect(readFileSync(f.env.MEMPHIS_VAULT_STATE_PATH!)).toEqual(before);
  });

  it('preserves v1 reads and TS migration to readable v2', () => {
    const f = fixture({
      salt: Buffer.alloc(32, 1).toString('base64'),
      masterKey: Buffer.alloc(32, 2).toString('base64'),
    });
    const before = native(f.env);
    expect(before.status, before.stderr).toBe(0);
    expect(vaultDecrypt(f.entry, f.env)).toBe('synthetic-first-credential');
    expect(JSON.parse(readFileSync(f.env.MEMPHIS_VAULT_STATE_PATH!, 'utf8')).version).toBe(2);
    const after = native(f.env);
    expect(after.status, after.stderr).toBe(0);
  });

  it('reads legacy v1 without a pepper and leaves the file unchanged', () => {
    const f = fixture({
      salt: Buffer.alloc(32, 1).toString('base64'),
      masterKey: Buffer.alloc(32, 2).toString('base64'),
    });
    delete f.env.MEMPHIS_VAULT_PEPPER;
    const before = readFileSync(f.env.MEMPHIS_VAULT_STATE_PATH!);
    const result = native(f.env);
    expect(result.status, result.stderr).toBe(0);
    expect(vaultDecrypt(f.entry, f.env)).toBe('synthetic-first-credential');
    expect(readFileSync(f.env.MEMPHIS_VAULT_STATE_PATH!)).toEqual(before);
  });

  it('preserves the JavaScript pepper length contract for non-BMP characters', () => {
    const unicodePepper = '\u{1f511}'.repeat(6); // 12 JS UTF-16 code units
    const kek = scryptSync(unicodePepper, 'memphis-vault-state-v2', 32, { N: 16384, r: 8, p: 1 });
    const cipher = createCipheriv('aes-256-gcm', kek, Buffer.from(golden.iv, 'base64'));
    const encrypted = Buffer.concat([cipher.update(Buffer.alloc(32, 2)), cipher.final()]);
    const f = fixture({
      ...golden,
      encryptedMasterKey: encrypted.toString('base64'),
      tag: cipher.getAuthTag().toString('base64'),
    });
    f.env.MEMPHIS_VAULT_PEPPER = unicodePepper;
    expect(vaultDecrypt(f.entry, f.env)).toBe('synthetic-first-credential');
    const result = native(f.env);
    expect(result.status, result.stderr).toBe(0);
  });

  it.each([
    ['missing', 'VAULT_STATE_MISSING'],
    ['unreadable', 'VAULT_STATE_UNREADABLE'],
    ['malformed', 'VAULT_STATE_MALFORMED'],
    ['nonce', 'VAULT_STATE_MALFORMED'],
    ['version', 'VAULT_STATE_UNSUPPORTED_VERSION'],
    ['pepper', 'VAULT_PEPPER_REQUIRED'],
    ['authentication', 'VAULT_STATE_AUTH_FAILED'],
  ])(
    'agrees on %s errors and never prints supplied data',
    (kind, code) => {
      const f = fixture();
      const statePath = f.env.MEMPHIS_VAULT_STATE_PATH!;
      const sentinel = 'synthetic-private-error-sentinel';
      if (kind === 'missing' || kind === 'unreadable') {
        rmSync(statePath);
        if (kind === 'unreadable') mkdirSync(statePath);
        // A valid sibling must not override an explicit missing path in native.
        if (kind === 'missing') {
          writeFileSync(statePath, JSON.stringify(golden));
          f.env.MEMPHIS_VAULT_STATE_PATH = `${f.root}/missing-state.json`;
        }
      }
      if (kind === 'malformed') writeFileSync(statePath, `{${sentinel}`);
      if (kind === 'nonce')
        writeFileSync(
          statePath,
          JSON.stringify({ ...golden, iv: Buffer.alloc(3).toString('base64') }),
        );
      if (kind === 'version')
        writeFileSync(statePath, JSON.stringify({ ...golden, version: 3, masterKey: sentinel }));
      if (kind === 'pepper') delete f.env.MEMPHIS_VAULT_PEPPER;
      if (kind === 'authentication') f.env.MEMPHIS_VAULT_PEPPER = sentinel;
      const result = bridge.vault_load_state(
        f.env.MEMPHIS_VAULT_STATE_PATH,
        f.env.MEMPHIS_VAULT_PEPPER ?? '',
      );
      expect(result.error_code).toBe(code);
      expect(result.vault).toBeUndefined();
      expect(JSON.stringify(result)).not.toContain(sentinel);
      expect(() => vaultDecrypt(f.entry, f.env)).toThrow(code);
      const secret = readVaultSecretByKey('first', { surface: 'system' }, f.env);
      expect(secret.errorCode).toBe(code);
      expect(secret.plaintext).toBeUndefined();
      expect(JSON.stringify(secret)).not.toContain(sentinel);
      const rust = native(f.env);
      expect(rust.signal).toBeNull();
      expect(rust.status, rust.stderr).toBe(3);
      expect(rust.stderr).toContain(code);
      expect(rust.stderr + rust.stdout).not.toContain(sentinel);
    },
    90000,
  );
});
