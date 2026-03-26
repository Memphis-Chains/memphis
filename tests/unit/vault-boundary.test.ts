import { beforeEach, describe, expect, it, vi } from 'vitest';

const writeSecurityAudit = vi.fn();
const vaultDecrypt = vi.fn();
const vaultEncrypt = vi.fn();
const vaultInit = vi.fn();
const getLatestVaultEntry = vi.fn();
const listVaultEntries = vi.fn();
const saveVaultEntry = vi.fn();
const verifyVaultEntry = vi.fn();

vi.mock('../../src/infra/logging/security-audit.js', () => ({
  writeSecurityAudit,
}));

vi.mock('../../src/infra/storage/rust-vault-adapter.js', () => ({
  vaultDecrypt,
  vaultEncrypt,
  vaultInit,
}));

vi.mock('../../src/infra/storage/vault-entry-store.js', () => ({
  getLatestVaultEntry,
  listVaultEntries,
  saveVaultEntry,
  verifyVaultEntry,
}));

describe('vault boundary', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns generic decrypt errors and keeps audit metadata safe', async () => {
    const { readVaultSecretByKey } = await import('../../src/security/vault-boundary.js');

    getLatestVaultEntry.mockReturnValue({
      id: 'entry-1',
      key: 'SHARED_LLM_API_KEY',
      createdAt: '2026-03-26T12:00:00.000Z',
      fingerprint: 'fp-1',
    });
    verifyVaultEntry.mockReturnValue(true);
    vaultDecrypt.mockImplementation(() => {
      throw new Error('decrypt failed with sensitive debug context');
    });

    const result = readVaultSecretByKey('SHARED_LLM_API_KEY', {
      surface: 'cli',
      command: 'vault get',
    });

    expect(result.error).toBe('Vault entry decryption failed');
    expect(writeSecurityAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'vault.secret-read',
        status: 'error',
        details: expect.objectContaining({
          surface: 'cli',
          command: 'vault get',
          reason: 'vault_decrypt_failed',
        }),
      }),
    );
    expect(writeSecurityAudit.mock.calls[0][0].details).not.toHaveProperty('plaintext');
    expect(writeSecurityAudit.mock.calls[0][0].details).not.toHaveProperty('message');
  });

  it('lists metadata without decrypting plaintext', async () => {
    const { listVaultEntryMetadata } = await import('../../src/security/vault-boundary.js');

    listVaultEntries.mockReturnValue([
      {
        id: 'entry-1',
        key: 'OPENAI_API_KEY',
        createdAt: '2026-03-26T12:00:00.000Z',
        fingerprint: 'fp-1',
      },
    ]);
    verifyVaultEntry.mockReturnValue(true);

    const entries = listVaultEntryMetadata({ surface: 'http', route: '/v1/vault/entries' });

    expect(entries).toEqual([
      expect.objectContaining({
        key: 'OPENAI_API_KEY',
        fingerprint: 'fp-1',
        integrityOk: true,
      }),
    ]);
    expect(vaultDecrypt).not.toHaveBeenCalled();
  });

  it('audits bounded-use secret access without exposing plaintext', async () => {
    const { useVaultSecretByKey } = await import('../../src/security/vault-boundary.js');

    getLatestVaultEntry.mockReturnValue({
      id: 'entry-2',
      key: 'MEMPHIS_API_TOKEN',
      createdAt: '2026-03-26T12:00:00.000Z',
      fingerprint: 'fp-2',
    });
    verifyVaultEntry.mockReturnValue(true);
    vaultDecrypt.mockReturnValue('super-secret-token');

    const result = useVaultSecretByKey('MEMPHIS_API_TOKEN', {
      surface: 'system',
      route: 'config:vault-resolve',
    });

    expect(result).toEqual(
      expect.objectContaining({
        found: true,
        key: 'MEMPHIS_API_TOKEN',
        plaintext: 'super-secret-token',
      }),
    );
    expect(writeSecurityAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'vault.bounded-use',
        status: 'allowed',
        route: 'config:vault-resolve',
        details: expect.objectContaining({
          surface: 'system',
          key: 'MEMPHIS_API_TOKEN',
        }),
      }),
    );
    expect(writeSecurityAudit.mock.calls[0][0].details).not.toHaveProperty('plaintext');
  });

  it('probes vault cipher cycle through bounded-use audit path', async () => {
    const { probeVaultCipherCycle } = await import('../../src/security/vault-boundary.js');

    vaultEncrypt.mockReturnValue({
      key: '__vault_probe__',
      ciphertext: 'enc',
      nonce: 'n',
      tag: 't',
      createdAt: '2026-03-26T12:00:00.000Z',
    });
    vaultDecrypt.mockReturnValue('vault_probe_12345678_deadbeef');

    const dateNow = vi.spyOn(Date, 'now').mockReturnValue(12345678);
    const randomSpy = vi.spyOn(Math, 'random').mockReturnValue(0xdeadbeef / 16 ** 8);

    const result = probeVaultCipherCycle({ surface: 'cli', command: 'doctor' });

    expect(result).toEqual({ ok: true });
    expect(vaultEncrypt).toHaveBeenCalledWith(
      '__vault_probe__',
      'vault_probe_12345678_deadbeef',
      expect.anything(),
    );
    expect(writeSecurityAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'vault.bounded-use',
        status: 'allowed',
        details: expect.objectContaining({
          surface: 'cli',
          command: 'doctor',
          probe: 'cipher-cycle',
        }),
      }),
    );

    dateNow.mockRestore();
    randomSpy.mockRestore();
  });
});
