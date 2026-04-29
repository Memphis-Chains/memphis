import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../src/security/vault-boundary.js', () => ({
  useVaultSecretByKey: vi.fn(),
}));

import { resolveVaultSecret, resolveVaultSecrets } from '../../src/infra/config/vault-resolve.js';
import { useVaultSecretByKey } from '../../src/security/vault-boundary.js';

const mockedUseVaultSecretByKey = vi.mocked(useVaultSecretByKey);

beforeEach(() => {
  vi.clearAllMocks();
});

describe('resolveVaultSecret', () => {
  it('returns plain values unchanged', () => {
    expect(resolveVaultSecret('sk-abc123')).toBe('sk-abc123');
    expect(resolveVaultSecret(undefined)).toBeUndefined();
    expect(resolveVaultSecret('')).toBe('');
  });

  it('resolves VAULT: prefix from vault entry', () => {
    mockedUseVaultSecretByKey.mockReturnValue({
      found: true,
      key: 'brave_search',
      plaintext: 'decrypted-brave-key',
      createdAt: '2026-01-01T00:00:00Z',
    });

    const result = resolveVaultSecret('VAULT:brave_search');
    expect(result).toBe('decrypted-brave-key');
    expect(mockedUseVaultSecretByKey).toHaveBeenCalledWith(
      'brave_search',
      expect.objectContaining({
        surface: 'system',
        route: 'config:vault-resolve',
      }),
      expect.anything(),
    );
  });

  it('returns undefined when vault entry not found', () => {
    mockedUseVaultSecretByKey.mockReturnValue({
      found: false,
      key: 'missing_key',
    });

    const result = resolveVaultSecret('VAULT:missing_key');
    expect(result).toBeUndefined();
  });

  it('returns undefined when decryption fails', () => {
    mockedUseVaultSecretByKey.mockReturnValue({
      found: true,
      key: 'broken',
      createdAt: '2026-01-01T00:00:00Z',
      error: 'Vault entry decryption failed',
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
    mockedUseVaultSecretByKey.mockReturnValue({
      found: true,
      key: 'shared_llm',
      plaintext: 'resolved-secret',
      createdAt: '2026-01-01T00:00:00Z',
    });

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
    mockedUseVaultSecretByKey.mockReturnValue({
      found: false,
      key: 'missing',
    });

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
