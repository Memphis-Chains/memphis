import { mkdtempSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { beforeEach, describe, expect, it } from 'vitest';

import {
  resetActiveVault,
  rotateVaultMasterKey,
  vaultDecrypt,
  vaultEncrypt,
  vaultInit,
} from '../../src/infra/storage/rust-vault-adapter.js';
import { saveVaultEntry } from '../../src/infra/storage/vault-entry-store.js';

function makeBridge(dir: string): string {
  const bridgePath = join(dir, 'bridge.cjs');
  writeFileSync(
    bridgePath,
    `const { createCipheriv, createDecipheriv, randomBytes } = require('node:crypto');

function encryptUnder(masterKey, plaintext) {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', masterKey, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();
  return { iv, ciphertext: encrypted, tag };
}

module.exports = {
  vault_load_state: require(${JSON.stringify(process.env.RUST_CHAIN_BRIDGE_PATH)}).vault_load_state,
  vault_parse_entries: require(${JSON.stringify(process.env.RUST_CHAIN_BRIDGE_PATH)}).vault_parse_entries,
  vault_decode_entry: require(${JSON.stringify(process.env.RUST_CHAIN_BRIDGE_PATH)}).vault_decode_entry,
  vault_init_full: () => ({
    vault: { salt: Buffer.alloc(32, 1), master_key: randomBytes(32) },
    did: 'did:memphis:test',
    qa_question: 'pet?'
  }),
  vault_store: (vault, key, plaintext) => {
    const { iv, ciphertext, tag } = encryptUnder(vault.master_key, Buffer.from(plaintext));
    return {
      id: 'entry-' + Math.random().toString(36).slice(2),
      key,
      ciphertext,
      nonce: iv,
      tag,
      created_at: new Date().toISOString(),
    };
  },
  vault_retrieve: (vault, entry) => {
    const iv = Buffer.isBuffer(entry.nonce) ? entry.nonce : Buffer.from(entry.nonce);
    const ciphertext = Buffer.isBuffer(entry.ciphertext) ? entry.ciphertext : Buffer.from(entry.ciphertext);
    const tag = Buffer.isBuffer(entry.tag) ? entry.tag : Buffer.from(entry.tag);
    const decipher = createDecipheriv('aes-256-gcm', vault.master_key, iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  }
};`,
    'utf8',
  );
  return bridgePath;
}

function makeEnv(dir: string): NodeJS.ProcessEnv {
  const bridgePath = makeBridge(dir);
  return {
    RUST_CHAIN_ENABLED: 'true',
    RUST_CHAIN_BRIDGE_PATH: bridgePath,
    MEMPHIS_VAULT_PEPPER: 'test-pepper-0123456789abcdef',
    MEMPHIS_VAULT_STATE_PATH: join(dir, 'vault-state.json'),
    MEMPHIS_VAULT_ENTRIES_PATH: join(dir, 'vault-entries.json'),
  } as NodeJS.ProcessEnv;
}

describe('rotateVaultMasterKey', () => {
  beforeEach(() => {
    resetActiveVault();
  });

  it('rotates a legacy v1 state without a separate migration invalidating its expected hash', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mv4-mkrotate-v1-'));
    const env = makeEnv(dir);
    vaultInit({ passphrase: 'p', recovery_question: 'q', recovery_answer: 'a' }, env);
    saveVaultEntry(vaultEncrypt('first', 'synthetic-first', env), env);
    const bridge = createRequire(import.meta.url)(env.RUST_CHAIN_BRIDGE_PATH!);
    const loaded = bridge.vault_load_state(
      env.MEMPHIS_VAULT_STATE_PATH!,
      env.MEMPHIS_VAULT_PEPPER!,
    );
    const vault = loaded.vault;
    writeFileSync(
      env.MEMPHIS_VAULT_STATE_PATH!,
      JSON.stringify({
        salt: vault.salt.toString('base64'),
        masterKey: (vault.master_key ?? vault.masterKey).toString('base64'),
      }),
    );
    resetActiveVault();

    expect(rotateVaultMasterKey(env).rotatedCount).toBe(1);
    expect(JSON.parse(readFileSync(env.MEMPHIS_VAULT_STATE_PATH!, 'utf8')).version).toBe(2);
    const entries = JSON.parse(readFileSync(env.MEMPHIS_VAULT_ENTRIES_PATH!, 'utf8'));
    resetActiveVault();
    expect(vaultDecrypt(entries[0], env)).toBe('synthetic-first');
  });

  it('re-encrypts every entry under a fresh master key and the secrets still decrypt', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mv4-mkrotate-ok-'));
    const env = makeEnv(dir);

    vaultInit({ passphrase: 'p', recovery_question: 'q', recovery_answer: 'a' }, env);
    saveVaultEntry(vaultEncrypt('anthropic_api_key', 'sk-alpha', env), env);
    saveVaultEntry(vaultEncrypt('minimax_api_key', 'mx-beta', env), env);

    const beforeState = readFileSync(env.MEMPHIS_VAULT_STATE_PATH!, 'utf8');
    const beforeEntries = readFileSync(env.MEMPHIS_VAULT_ENTRIES_PATH!, 'utf8');

    const result = rotateVaultMasterKey(env);

    expect(result.rotatedCount).toBe(2);
    expect(result.statePath).toBe(env.MEMPHIS_VAULT_STATE_PATH);
    expect(result.entriesPath).toBe(env.MEMPHIS_VAULT_ENTRIES_PATH);

    const afterState = readFileSync(env.MEMPHIS_VAULT_STATE_PATH!, 'utf8');
    const afterEntries = readFileSync(env.MEMPHIS_VAULT_ENTRIES_PATH!, 'utf8');
    expect(afterState).not.toBe(beforeState);
    expect(afterEntries).not.toBe(beforeEntries);

    resetActiveVault();
    expect(
      vaultDecrypt(
        {
          ...(
            JSON.parse(afterEntries) as Array<{
              id: string;
              key: string;
              encrypted: string;
              iv: string;
              tag: string;
            }>
          )[0],
        },
        env,
      ),
    ).toBe('sk-alpha');
  });

  it('aborts with a descriptive error when an entry cannot be decrypted under the current master key', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mv4-mkrotate-fail-'));
    const env = makeEnv(dir);

    vaultInit({ passphrase: 'p', recovery_question: 'q', recovery_answer: 'a' }, env);
    saveVaultEntry(vaultEncrypt('good_key', 'good-secret', env), env);

    const entriesPath = env.MEMPHIS_VAULT_ENTRIES_PATH!;
    const raw = JSON.parse(readFileSync(entriesPath, 'utf8')) as Array<Record<string, string>>;
    raw.push({
      id: 'broken-1',
      key: 'bad_key',
      encrypted: Buffer.alloc(32, 0xff).toString('base64'),
      iv: Buffer.alloc(12, 0xee).toString('base64'),
      tag: Buffer.alloc(16, 0xdd).toString('base64'),
      createdAt: '2026-04-13T00:00:00.000Z',
      fingerprint: 'x'.repeat(64),
    });
    writeFileSync(entriesPath, JSON.stringify(raw, null, 2));

    expect(() => rotateVaultMasterKey(env)).toThrow(/aborted.*bad_key/s);
  });

  it('fails loud when vault state is missing', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mv4-mkrotate-missing-'));
    const env = makeEnv(dir);
    expect(() => rotateVaultMasterKey(env)).toThrow(/vault state not found/i);
  });

  it('clears plaintext and the new key when re-encryption fails before publication', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mv4-mkrotate-store-fail-'));
    const env = makeEnv(dir);
    vaultInit({ passphrase: 'p', recovery_question: 'q', recovery_answer: 'a' }, env);
    saveVaultEntry(vaultEncrypt('first', 'synthetic-first', env), env);
    saveVaultEntry(vaultEncrypt('second', 'synthetic-second', env), env);
    const beforeState = readFileSync(env.MEMPHIS_VAULT_STATE_PATH!);
    const beforeEntries = readFileSync(env.MEMPHIS_VAULT_ENTRIES_PATH!);
    const bridge = createRequire(import.meta.url)(env.RUST_CHAIN_BRIDGE_PATH!);
    const originalStore = bridge.vault_store;
    const plaintexts: Buffer[] = [];
    let newKey: Buffer | undefined;
    bridge.vault_store = (vault: { master_key: Buffer }, key: string, plaintext: Buffer) => {
      newKey = vault.master_key;
      plaintexts.push(plaintext);
      if (plaintexts.length === 2) throw new Error('synthetic re-encryption failure');
      return originalStore(vault, key, plaintext);
    };

    expect(() => rotateVaultMasterKey(env)).toThrow('synthetic re-encryption failure');
    expect(plaintexts).toHaveLength(2);
    for (const plaintext of plaintexts)
      expect(plaintext.equals(Buffer.alloc(plaintext.length))).toBe(true);
    expect(newKey?.equals(Buffer.alloc(32))).toBe(true);
    expect(readFileSync(env.MEMPHIS_VAULT_STATE_PATH!)).toEqual(beforeState);
    expect(readFileSync(env.MEMPHIS_VAULT_ENTRIES_PATH!)).toEqual(beforeEntries);
    resetActiveVault();
    expect(vaultDecrypt(JSON.parse(beforeEntries.toString())[0], env)).toBe('synthetic-first');
  });

  it.each(['', '[null]', '{"private-sentinel":'])(
    'preserves state and entries when rotation input is malformed: %j',
    (contents) => {
      const dir = mkdtempSync(join(tmpdir(), 'mv4-mkrotate-malformed-'));
      const env = makeEnv(dir);
      // A v1 fixture avoids unrelated KDF work and exercises rotation's real loader.
      writeFileSync(
        env.MEMPHIS_VAULT_STATE_PATH!,
        JSON.stringify({
          version: 1,
          salt: Buffer.alloc(32, 1).toString('base64'),
          masterKey: Buffer.alloc(32, 2).toString('base64'),
        }),
      );
      writeFileSync(env.MEMPHIS_VAULT_ENTRIES_PATH!, contents);
      const beforeState = readFileSync(env.MEMPHIS_VAULT_STATE_PATH!);
      expect(() => rotateVaultMasterKey(env)).toThrow('VAULT_ENTRIES_MALFORMED');
      expect(readFileSync(env.MEMPHIS_VAULT_STATE_PATH!)).toEqual(beforeState);
      expect(readFileSync(env.MEMPHIS_VAULT_ENTRIES_PATH!, 'utf8')).toBe(contents);
    },
  );

  it('allows a missing entries file (no entries to rotate)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mv4-mkrotate-empty-'));
    const env = makeEnv(dir);

    vaultInit({ passphrase: 'p', recovery_question: 'q', recovery_answer: 'a' }, env);

    const result = rotateVaultMasterKey(env);
    expect(result.rotatedCount).toBe(0);
    expect(existsSync(env.MEMPHIS_VAULT_STATE_PATH!)).toBe(true);
  });
});
