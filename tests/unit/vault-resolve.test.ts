import { beforeEach, describe, expect, it, vi } from 'vitest';

// 2026-10-09: `resolveVaultSecret` moved from the result-object helper to
// `withVaultSecret`, which hands the plaintext to a callback and never
// returns it. The mock follows the new contract, otherwise every assertion
// below would exercise a helper that no longer exists.
// `vi.mock` is hoisted above class declarations, so the error class has to
// be created inside `vi.hoisted` — referencing it from the factory scope
// directly throws "Cannot access before initialization".
const { withVaultSecret: mockedWithVaultSecret, VaultSecretUnavailableError } = vi.hoisted(() => {
  class VaultSecretUnavailableError extends Error {
    constructor(key: string, reason: string) {
      super(`Vault secret "${key}" unavailable: ${reason}`);
      this.name = 'VaultSecretUnavailableError';
    }
  }
  return {
    withVaultSecret: vi.fn(),
    VaultSecretUnavailableError,
  };
});

vi.mock('../../src/security/vault-boundary.js', () => ({
  withVaultSecret: mockedWithVaultSecret,
  VaultSecretUnavailableError,
}));

import { resolveVaultSecret, resolveVaultSecrets } from '../../src/infra/config/vault-resolve.js';

/** Old result-object shape → new callback shape. */
function withSecret(value: string | undefined) {
  mockedWithVaultSecret.mockImplementation((key, _ctx, fn) => {
    if (value === undefined) {
      throw new VaultSecretUnavailableError(String(key), 'no vault entry found');
    }
    return fn(value);
  });
}

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
    withSecret('decrypted-brave-key');

    const result = resolveVaultSecret('VAULT:brave_search');
    expect(result).toBe('decrypted-brave-key');
    expect(mockedWithVaultSecret).toHaveBeenCalledWith(
      'brave_search',
      expect.objectContaining({
        surface: 'system',
        route: 'config:vault-resolve',
      }),
      expect.any(Function),
      expect.anything(),
    );
  });

  it('returns undefined when vault entry not found', () => {
    withSecret(undefined);

    const result = resolveVaultSecret('VAULT:missing_key');
    expect(result).toBeUndefined();
  });

  it('returns undefined when decryption fails', () => {
    withSecret(undefined);

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
    withSecret('resolved-secret');

    const env: NodeJS.ProcessEnv = {
      SHARED_LLM_API_KEY: 'VAULT:shared_llm',
      DECENTRALIZED_LLM_API_KEY: 'plain-key-stays',
      RUST_EMBED_PROVIDER_API_KEY: 'VAULT:embed_key',
    };

    const result = resolveVaultSecrets(env);

    expect(result.resolved).toContain('SHARED_LLM_API_KEY');
    expect(result.resolved).toContain('RUST_EMBED_PROVIDER_API_KEY');
    expect(result.resolved).not.toContain('DECENTRALIZED_LLM_API_KEY');
    expect(result.failed).toEqual([]);
    expect(env.SHARED_LLM_API_KEY).toBe('resolved-secret');
    expect(env.DECENTRALIZED_LLM_API_KEY).toBe('plain-key-stays');
    expect(env.RUST_EMBED_PROVIDER_API_KEY).toBe('resolved-secret');
  });

  it('separates resolved and failed when vault resolution fails (#276)', () => {
    withSecret(undefined);

    const env: NodeJS.ProcessEnv = {
      SHARED_LLM_API_KEY: 'VAULT:missing',
    };

    const result = resolveVaultSecrets(env);

    expect(env.SHARED_LLM_API_KEY).toBeUndefined();
    // Failed key is reported as such, NOT as resolved.
    expect(result.failed).toContain('SHARED_LLM_API_KEY');
    expect(result.resolved).not.toContain('SHARED_LLM_API_KEY');
  });

  it('skips non-VAULT values', () => {
    const env: NodeJS.ProcessEnv = {
      SHARED_LLM_API_KEY: 'sk-real-key',
    };

    const result = resolveVaultSecrets(env);
    expect(result.resolved).toHaveLength(0);
    expect(result.failed).toHaveLength(0);
    expect(env.SHARED_LLM_API_KEY).toBe('sk-real-key');
  });
});
