import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { getRustVaultAdapterStatus, vaultInit } from '../../src/infra/storage/rust-vault-adapter.js';

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
});
