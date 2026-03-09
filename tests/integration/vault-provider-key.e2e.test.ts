import { describe, expect, it } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { listVaultEntries, saveVaultEntry } from '../../src/infra/storage/vault-entry-store.js';
import { vaultDecrypt, vaultEncrypt } from '../../src/infra/storage/rust-vault-adapter.js';
import { loadConfig } from '../../src/infra/config/env.js';

describe('vault provider-key path', () => {
  it('round-trips provider key via vault and validates config load path', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mv4-vault-provider-'));
    const bridgePath = join(dir, 'mock-bridge.cjs');
    const entriesPath = join(dir, 'vault-entries.json');

    writeFileSync(
      bridgePath,
      `module.exports = {
  vault_init: () => JSON.stringify({ ok: true, data: { version: 1, did: 'did:memphis:test' } }),
  vault_encrypt: (key, plaintext) => JSON.stringify({ ok: true, data: { key, encrypted: 'enc:' + plaintext, iv: 'iv' } }),
  vault_decrypt: (entryJson) => {
    const e = JSON.parse(entryJson);
    return JSON.stringify({ ok: true, data: { plaintext: String(e.encrypted).replace('enc:', '') } });
  }
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
    };

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
