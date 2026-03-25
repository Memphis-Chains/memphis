import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import { loadConfig } from '../../src/infra/config/env.js';
import { vaultDecrypt, vaultEncrypt, vaultInit , resetActiveVault } from '../../src/infra/storage/rust-vault-adapter.js';
import { listVaultEntries, saveVaultEntry } from '../../src/infra/storage/vault-entry-store.js';

vi.mock('../../src/infra/auth/operator-gate.js', () => ({
  isOperatorConfigured: vi.fn(() => true),
  isSessionAuthorized: vi.fn(() => true),
  authorizeSession: vi.fn(),
  validateOperatorPassphrase: vi.fn(() => true),
  isGatedOperation: vi.fn(() => false),
  requireOperatorAuth: vi.fn(async () => true),
}));

describe('vault provider-key path', () => {
  it('round-trips provider key via vault and validates config load path', () => {
    resetActiveVault();
    const dir = mkdtempSync(join(tmpdir(), 'mv4-vault-provider-'));
    const bridgePath = join(dir, 'mock-bridge.cjs');
    const entriesPath = join(dir, 'vault-entries.json');

    writeFileSync(
      bridgePath,
      `let _vault = null;
module.exports = {
  vault_init_full: () => {
    _vault = { salt: Buffer.alloc(32, 1), masterKey: Buffer.alloc(32, 2) };
    return { vault: _vault, did: 'did:memphis:test', qa_question: 'pet?' };
  },
  vault_store: (_vault, key, plaintext) => ({
    id: 'entry-1',
    key,
    ciphertext: plaintext,
    nonce: Buffer.alloc(12, 3),
    tag: Buffer.alloc(16, 4),
    created_at: new Date().toISOString()
  }),
  vault_retrieve: (_vault, entry) => entry.ciphertext
};`,
    );

    const env: NodeJS.ProcessEnv = {
      ...process.env,
      NODE_ENV: 'test',
      DEFAULT_PROVIDER: 'shared-llm',
      SHARED_LLM_API_BASE: 'https://example.test/v1',
      RUST_CHAIN_ENABLED: 'true',
      RUST_CHAIN_BRIDGE_PATH: bridgePath,
      MEMPHIS_VAULT_PEPPER: 'very-secure-pepper',
      MEMPHIS_VAULT_ENTRIES_PATH: entriesPath,
      MEMPHIS_VAULT_STATE_PATH: join(dir, 'vault-state.json'),
    };

    vaultInit({ passphrase: 'VeryStrongPassphrase!123', recovery_question: 'pet?', recovery_answer: 'nori' }, env);
    const encrypted = vaultEncrypt('SHARED_LLM_API_KEY', 'sk-from-vault', env);
    saveVaultEntry(encrypted, env);

    const latest = listVaultEntries(env, 'SHARED_LLM_API_KEY').at(-1);
    expect(latest).toBeDefined();

    const decrypted = vaultDecrypt(latest!, env);
    expect(decrypted).toBe('sk-from-vault');

    env.SHARED_LLM_API_KEY = decrypted;
    const cfg = loadConfig(env);
    expect(cfg.SHARED_LLM_API_KEY).toBe('sk-from-vault');
  });
});
