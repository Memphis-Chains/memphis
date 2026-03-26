import { beforeEach, describe, expect, it, vi } from 'vitest';

const writeSecurityAudit = vi.fn();
const vaultDecrypt = vi.fn();
const getLatestVaultEntry = vi.fn();
const listVaultEntries = vi.fn();
const verifyVaultEntry = vi.fn();

vi.mock('../../src/infra/logging/security-audit.js', () => ({
  writeSecurityAudit,
}));

vi.mock('../../src/infra/storage/rust-vault-adapter.js', () => ({
  vaultDecrypt,
}));

vi.mock('../../src/infra/storage/vault-entry-store.js', () => ({
  getLatestVaultEntry,
  listVaultEntries,
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
});
