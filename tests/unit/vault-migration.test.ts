import { mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it, beforeEach } from 'vitest';

import {
  resetActiveVault,
  vaultDecrypt,
  vaultEncrypt,
  vaultInit,
} from '../../src/infra/storage/rust-vault-adapter.js';

function makeBridge(dir: string) {
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
    created_at: '2026-03-21T00:00:00.000Z'
  }),
  vault_retrieve: (_vault, entry) => Buffer.from(entry.ciphertext)
};`,
    'utf8',
  );
  return bridgePath;
}

function makeEnv(dir: string, bridgePath: string): NodeJS.ProcessEnv {
  return {
    RUST_CHAIN_ENABLED: 'true',
    RUST_CHAIN_BRIDGE_PATH: bridgePath,
    MEMPHIS_VAULT_PEPPER: 'test-pepper-0123456789abcdef',
    MEMPHIS_VAULT_STATE_PATH: join(dir, 'vault-state.json'),
  } as NodeJS.ProcessEnv;
}

describe('vault state migration v1 -> v2', () => {
  beforeEach(() => {
    resetActiveVault();
  });

  it('new vault init writes v2 encrypted state', () => {
    const dir = mkdtempSync(join(tmpdir(), 'vault-mig-new-'));
    const bridgePath = makeBridge(dir);
    const rawEnv = makeEnv(dir, bridgePath);
    const statePath = rawEnv.MEMPHIS_VAULT_STATE_PATH!;

    vaultInit({ passphrase: 'test', recovery_question: 'pet?', recovery_answer: 'nori' }, rawEnv);

    const state = JSON.parse(readFileSync(statePath, 'utf8'));
    expect(state.version).toBe(2);
    expect(state.encryptedMasterKey).toBeDefined();
    expect(state.iv).toBeDefined();
    expect(state.tag).toBeDefined();
    expect(state.masterKey).toBeUndefined();
  });

  it('loads v1 state and upgrades to v2 transparently', () => {
    const dir = mkdtempSync(join(tmpdir(), 'vault-mig-v1-'));
    const bridgePath = makeBridge(dir);
    const rawEnv = makeEnv(dir, bridgePath);
    const statePath = rawEnv.MEMPHIS_VAULT_STATE_PATH!;

    // Write a v1 state file (plaintext base64)
    const v1State = {
      salt: Buffer.alloc(32, 1).toString('base64'),
      masterKey: Buffer.alloc(32, 2).toString('base64'),
    };
    writeFileSync(statePath, JSON.stringify(v1State));

    // Access vault — should trigger load and upgrade
    const encrypted = vaultEncrypt('k', 'hello', rawEnv);
    expect(encrypted.id).toBe('entry-1');

    // Verify state file was upgraded to v2
    const upgraded = JSON.parse(readFileSync(statePath, 'utf8'));
    expect(upgraded.version).toBe(2);
    expect(upgraded.encryptedMasterKey).toBeDefined();
    expect(upgraded.masterKey).toBeUndefined();

    // Verify original master key is NOT in the file as plaintext
    const rawContent = readFileSync(statePath, 'utf8');
    const originalKeyBase64 = Buffer.alloc(32, 2).toString('base64');
    expect(rawContent).not.toContain(originalKeyBase64);
  });

  it('v2 state loads correctly after reset', () => {
    const dir = mkdtempSync(join(tmpdir(), 'vault-mig-v2reload-'));
    const bridgePath = makeBridge(dir);
    const rawEnv = makeEnv(dir, bridgePath);

    // Init creates v2 state
    vaultInit({ passphrase: 'test', recovery_question: 'pet?', recovery_answer: 'nori' }, rawEnv);

    // Reset in-memory state
    resetActiveVault();

    // Load from disk and use
    const encrypted = vaultEncrypt('k', 'hello', rawEnv);
    expect(encrypted.id).toBe('entry-1');

    const plaintext = vaultDecrypt(encrypted, rawEnv);
    expect(plaintext).toBe('hello');
  });

  it('vault state file has 0o600 permissions', () => {
    if (process.platform === 'win32') return; // chmod is no-op on Windows

    const dir = mkdtempSync(join(tmpdir(), 'vault-mig-perms-'));
    const bridgePath = makeBridge(dir);
    const rawEnv = makeEnv(dir, bridgePath);
    const statePath = rawEnv.MEMPHIS_VAULT_STATE_PATH!;

    vaultInit({ passphrase: 'test', recovery_question: 'pet?', recovery_answer: 'nori' }, rawEnv);

    const fileStat = statSync(statePath);
    const perms = fileStat.mode & 0o777;
    expect(perms).toBe(0o600);
  });

  it('corrupt v2 state returns null gracefully', () => {
    const dir = mkdtempSync(join(tmpdir(), 'vault-mig-corrupt-'));
    const bridgePath = makeBridge(dir);
    const rawEnv = makeEnv(dir, bridgePath);
    const statePath = rawEnv.MEMPHIS_VAULT_STATE_PATH!;

    // Write a corrupt v2 state
    writeFileSync(
      statePath,
      JSON.stringify({
        version: 2,
        salt: Buffer.alloc(32, 1).toString('base64'),
        encryptedMasterKey: 'garbage',
        iv: 'garbage',
        tag: 'garbage',
      }),
    );

    // Should not throw, just fail to load
    expect(() => vaultEncrypt('k', 'hello', rawEnv)).toThrow(/vault not initialized/);
  });

  it('v2 state with wrong pepper fails to load', () => {
    const dir = mkdtempSync(join(tmpdir(), 'vault-mig-wrongpepper-'));
    const bridgePath = makeBridge(dir);
    const rawEnv = makeEnv(dir, bridgePath);

    // Init with correct pepper
    vaultInit({ passphrase: 'test', recovery_question: 'pet?', recovery_answer: 'nori' }, rawEnv);

    resetActiveVault();

    // Try to load with different pepper
    const wrongEnv = {
      ...rawEnv,
      MEMPHIS_VAULT_PEPPER: 'wrong-pepper-0123456789',
    } as NodeJS.ProcessEnv;

    expect(() => vaultEncrypt('k', 'hello', wrongEnv)).toThrow(/vault not initialized/);
  });
});
