import { describe, expect, it, vi } from 'vitest';

// Mock vault-entry-store and rust-vault-adapter before importing
vi.mock('../../src/infra/storage/vault-entry-store.js', () => ({
  getLatestVaultEntry: vi.fn(),
}));

vi.mock('../../src/infra/storage/rust-vault-adapter.js', () => ({
  vaultDecrypt: vi.fn(),
}));

import { resolveVaultSecret, resolveVaultSecrets } from '../../src/infra/config/vault-resolve.js';
import { vaultDecrypt } from '../../src/infra/storage/rust-vault-adapter.js';
import { getLatestVaultEntry } from '../../src/infra/storage/vault-entry-store.js';

const mockedGetLatest = vi.mocked(getLatestVaultEntry);
const mockedDecrypt = vi.mocked(vaultDecrypt);

describe('resolveVaultSecret', () => {
  it('returns plain values unchanged', () => {
    expect(resolveVaultSecret('sk-abc123')).toBe('sk-abc123');
    expect(resolveVaultSecret(undefined)).toBeUndefined();
    expect(resolveVaultSecret('')).toBe('');
  });

  it('resolves VAULT: prefix from vault entry', () => {
    const fakeEntry = {
      key: 'brave_search',
      encrypted: 'enc',
      iv: 'iv',
      tag: 'tag',
      createdAt: '2026-01-01T00:00:00Z',
      fingerprint: 'abc',
    };
    mockedGetLatest.mockReturnValue(fakeEntry as ReturnType<typeof getLatestVaultEntry>);
    mockedDecrypt.mockReturnValue('decrypted-brave-key');

    const result = resolveVaultSecret('VAULT:brave_search');
    expect(result).toBe('decrypted-brave-key');
    expect(mockedGetLatest).toHaveBeenCalledWith('brave_search', expect.anything());
    expect(mockedDecrypt).toHaveBeenCalledWith(fakeEntry, expect.anything());
  });

  it('returns undefined when vault entry not found', () => {
    mockedGetLatest.mockReturnValue(undefined);

    const result = resolveVaultSecret('VAULT:missing_key');
    expect(result).toBeUndefined();
  });

  it('returns undefined when decryption fails', () => {
    const fakeEntry = {
      key: 'broken',
      encrypted: 'enc',
      iv: 'iv',
      tag: 'tag',
      createdAt: '2026-01-01T00:00:00Z',
      fingerprint: 'abc',
    };
    mockedGetLatest.mockReturnValue(fakeEntry as ReturnType<typeof getLatestVaultEntry>);
    mockedDecrypt.mockImplementation(() => {
      throw new Error('decryption failed');
    });

    const result = resolveVaultSecret('VAULT:broken');
    expect(result).toBeUndefined();
  });

  it('handles VAULT: with empty key name', () => {
    expect(resolveVaultSecret('VAULT:')).toBeUndefined();
    expect(resolveVaultSecret('VAULT:  ')).toBeUndefined();
  });
});

describe('resolveVaultSecrets', () => {
  it('resolves multiple VAULT: references in env', () => {
    const fakeEntry = {
      key: 'shared_llm',
      encrypted: 'enc',
      iv: 'iv',
      tag: 'tag',
      createdAt: '2026-01-01T00:00:00Z',
      fingerprint: 'abc',
    };
    mockedGetLatest.mockReturnValue(fakeEntry as ReturnType<typeof getLatestVaultEntry>);
    mockedDecrypt.mockReturnValue('resolved-secret');

    const env: NodeJS.ProcessEnv = {
      SHARED_LLM_API_KEY: 'VAULT:shared_llm',
      DECENTRALIZED_LLM_API_KEY: 'plain-key-stays',
      RUST_EMBED_PROVIDER_API_KEY: 'VAULT:embed_key',
    };

    const resolved = resolveVaultSecrets(env);

    expect(resolved).toContain('SHARED_LLM_API_KEY');
    expect(resolved).toContain('RUST_EMBED_PROVIDER_API_KEY');
    expect(resolved).not.toContain('DECENTRALIZED_LLM_API_KEY');
    expect(env.SHARED_LLM_API_KEY).toBe('resolved-secret');
    expect(env.DECENTRALIZED_LLM_API_KEY).toBe('plain-key-stays');
    expect(env.RUST_EMBED_PROVIDER_API_KEY).toBe('resolved-secret');
  });

  it('deletes env key when vault resolution fails', () => {
    mockedGetLatest.mockReturnValue(undefined);

    const env: NodeJS.ProcessEnv = {
      SHARED_LLM_API_KEY: 'VAULT:missing',
    };

    resolveVaultSecrets(env);

    expect(env.SHARED_LLM_API_KEY).toBeUndefined();
  });

  it('skips non-VAULT values', () => {
    const env: NodeJS.ProcessEnv = {
      SHARED_LLM_API_KEY: 'sk-real-key',
    };

    const resolved = resolveVaultSecrets(env);
    expect(resolved).toHaveLength(0);
    expect(env.SHARED_LLM_API_KEY).toBe('sk-real-key');
  });
});
