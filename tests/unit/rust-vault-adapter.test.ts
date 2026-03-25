import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  getRustVaultAdapterStatus,
  vaultDecrypt,
  vaultEncrypt,
  vaultInit,
} from '../../src/infra/storage/rust-vault-adapter.js';

describe('rust vault adapter status', () => {
  it('returns disabled status by default', () => {
    const out = getRustVaultAdapterStatus({
      RUST_CHAIN_ENABLED: 'false',
    } as NodeJS.ProcessEnv);

    expect(out.rustEnabled).toBe(false);
    expect(out.bridgeLoaded).toBe(false);
    expect(out.vaultApiAvailable).toBe(false);
  });

  it('returns safe fallback when bridge path is missing', () => {
    const out = getRustVaultAdapterStatus({
      RUST_CHAIN_ENABLED: 'true',
      RUST_CHAIN_BRIDGE_PATH: '/tmp/missing-rust-bridge.node',
    } as NodeJS.ProcessEnv);

    expect(out.rustEnabled).toBe(true);
    expect(out.bridgeLoaded).toBe(false);
    expect(out.vaultApiAvailable).toBe(false);
  });

  it('requires MEMPHIS_VAULT_PEPPER for runtime vault calls', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mv4-vault-adapter-'));
    const bridgePath = join(dir, 'bridge.cjs');
    writeFileSync(
      bridgePath,
      `module.exports = {
  vault_init: () => JSON.stringify({ ok: true, data: { version: 1, did: 'did:memphis:test' } }),
  vault_encrypt: () => JSON.stringify({ ok: true, data: { key: 'k', encrypted: 'x', iv: 'y' } }),
  vault_decrypt: () => JSON.stringify({ ok: true, data: { plaintext: 'x' } })
};`,
      'utf8',
    );

    expect(() =>
      vaultInit(
        {
          passphrase: 'VeryStrongPassphrase!123',
          recovery_question: 'pet?',
          recovery_answer: 'nori',
        },
        {
          RUST_CHAIN_ENABLED: 'true',
          RUST_CHAIN_BRIDGE_PATH: bridgePath,
        } as NodeJS.ProcessEnv,
      ),
    ).toThrow(/MEMPHIS_VAULT_PEPPER/);
  });

  it('supports canonical snake_case vault bridge exports', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mv4-vault-adapter-snake-'));
    const bridgePath = join(dir, 'bridge.cjs');
    writeFileSync(
      bridgePath,
      `module.exports = {
  vault_init_full: () => ({
    vault: { salt: Buffer.alloc(32, 1), master_key: Buffer.alloc(32, 2) },
    did: 'did:memphis:test',
    qa_question: 'pet?'
  }),
  vault_store: (_vault, key, plaintext) => ({
    id: 'entry-1',
    key,
    ciphertext: Buffer.from(plaintext),
    nonce: Buffer.alloc(12, 3),
    tag: Buffer.alloc(16, 4),
    created_at: '2026-03-11T00:00:00.000Z'
  }),
  vault_retrieve: (_vault, entry) => Buffer.from(entry.ciphertext)
};`,
      'utf8',
    );

    const rawEnv = {
      RUST_CHAIN_ENABLED: 'true',
      RUST_CHAIN_BRIDGE_PATH: bridgePath,
      MEMPHIS_VAULT_PEPPER: '0123456789abcdef',
      MEMPHIS_VAULT_STATE_PATH: join(dir, 'vault-state.json'),
    } as NodeJS.ProcessEnv;

    const init = vaultInit(
      {
        passphrase: 'VeryStrongPassphrase!123',
        recovery_question: 'pet?',
        recovery_answer: 'nori',
      },
      rawEnv,
    );
    expect(init.did).toBe('did:memphis:test');

    const encrypted = vaultEncrypt('k', 'hello', rawEnv);
    expect(encrypted.id).toBe('entry-1');
    expect(encrypted.createdAt).toBe('2026-03-11T00:00:00.000Z');
    expect(typeof encrypted.tag).toBe('string');

    const plaintext = vaultDecrypt(encrypted, rawEnv);
    expect(plaintext).toBe('hello');
  });

  it('keeps compatibility with historical camelCase vault bridge exports', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mv4-vault-adapter-camel-'));
    const bridgePath = join(dir, 'bridge.cjs');
    writeFileSync(
      bridgePath,
      `module.exports = {
  vaultInitFull: () => ({
    vault: { salt: Buffer.alloc(32, 1), master_key: Buffer.alloc(32, 2) },
    did: 'did:memphis:compat',
    qa_question: 'pet?'
  }),
  vaultStore: (_vault, key, plaintext) => ({
    id: 'entry-compat',
    key,
    ciphertext: Buffer.from(plaintext),
    nonce: Buffer.alloc(12, 3),
    tag: Buffer.alloc(16, 4),
    created_at: '2026-03-11T00:00:00.000Z'
  }),
  vaultRetrieve: (_vault, entry) => Buffer.from(entry.ciphertext)
};`,
      'utf8',
    );

    const rawEnv = {
      RUST_CHAIN_ENABLED: 'true',
      RUST_CHAIN_BRIDGE_PATH: bridgePath,
      MEMPHIS_VAULT_PEPPER: '0123456789abcdef',
      MEMPHIS_VAULT_STATE_PATH: join(dir, 'vault-state.json'),
    } as NodeJS.ProcessEnv;

    const init = vaultInit(
      {
        passphrase: 'VeryStrongPassphrase!123',
        recovery_question: 'pet?',
        recovery_answer: 'nori',
      },
      rawEnv,
    );
    expect(init.did).toBe('did:memphis:compat');

    const encrypted = vaultEncrypt('k', 'hello', rawEnv);
    expect(encrypted.id).toBe('entry-compat');

    const plaintext = vaultDecrypt(encrypted, rawEnv);
    expect(plaintext).toBe('hello');
  });

  it('normalizes masterKey-only vault payloads from the new bridge contract', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mv4-vault-adapter-masterkey-'));
    const bridgePath = join(dir, 'bridge.cjs');
    writeFileSync(
      bridgePath,
      `module.exports = {
  vault_init_full: () => ({
    vault: { salt: Buffer.alloc(32, 1), masterKey: Buffer.alloc(32, 2) },
    did: 'did:memphis:masterkey',
    qa_question: 'pet?'
  }),
  vault_store: (_vault, key, plaintext) => ({
    id: 'entry-masterkey',
    key,
    ciphertext: Buffer.from(plaintext),
    nonce: Buffer.alloc(12, 3),
    tag: Buffer.alloc(16, 4),
    created_at: '2026-03-11T00:00:00.000Z'
  }),
  vault_retrieve: (_vault, entry) => Buffer.from(entry.ciphertext)
};`,
      'utf8',
    );

    const rawEnv = {
      RUST_CHAIN_ENABLED: 'true',
      RUST_CHAIN_BRIDGE_PATH: bridgePath,
      MEMPHIS_VAULT_PEPPER: '0123456789abcdef',
      MEMPHIS_VAULT_STATE_PATH: join(dir, 'vault-state.json'),
    } as NodeJS.ProcessEnv;

    const init = vaultInit(
      {
        passphrase: 'VeryStrongPassphrase!123',
        recovery_question: 'pet?',
        recovery_answer: 'nori',
      },
      rawEnv,
    );
    expect(init.did).toBe('did:memphis:masterkey');

    const encrypted = vaultEncrypt('k', 'hello', rawEnv);
    expect(encrypted.id).toBe('entry-masterkey');

    const plaintext = vaultDecrypt(encrypted, rawEnv);
    expect(plaintext).toBe('hello');
  });

  it('surfaces legacy bridge envelope errors instead of accepting { ok: false }', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mv4-vault-adapter-envelope-'));
    const bridgePath = join(dir, 'bridge.cjs');
    writeFileSync(
      bridgePath,
      `module.exports = {
  vault_init_json: () => JSON.stringify({ ok: false, error: 'legacy init failed' }),
  vault_encrypt: () => JSON.stringify({ ok: true, data: { key: 'k', encrypted: 'x', iv: 'y' } }),
  vault_decrypt: () => JSON.stringify({ ok: true, data: { plaintext: 'x' } })
};`,
      'utf8',
    );

    expect(() =>
      vaultInit(
        {
          passphrase: 'VeryStrongPassphrase!123',
          recovery_question: 'pet?',
          recovery_answer: 'nori',
        },
        {
          RUST_CHAIN_ENABLED: 'true',
          RUST_CHAIN_BRIDGE_PATH: bridgePath,
          MEMPHIS_VAULT_PEPPER: '0123456789abcdef',
          MEMPHIS_VAULT_STATE_PATH: join(dir, 'vault-state.json'),
        } as NodeJS.ProcessEnv,
      ),
    ).toThrow('legacy init failed');
  });
});
