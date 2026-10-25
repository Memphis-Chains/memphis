import { beforeEach, describe, expect, it, vi } from 'vitest';

const { read } = vi.hoisted(() => ({ read: vi.fn() }));
vi.mock('../../src/security/vault-boundary.js', () => ({ readVaultSecretByKey: read }));
import { resolveProviderKeyResult, resolveProviderVaultKey } from '../../src/providers/index.js';

describe('provider vault references', () => {
  beforeEach(() => read.mockReset());
  it('uses the configured reference in both resolution APIs', () => {
    const env = { MINIMAX_VAULT_KEY: ' custom-minimax ' };
    read.mockReturnValue({ found: true, plaintext: 'synthetic-secret' });
    expect(resolveProviderVaultKey('minimax', env)).toBe('synthetic-secret');
    expect(resolveProviderKeyResult('minimax', env)).toEqual({
      source: 'vault',
      key: 'synthetic-secret',
    });
    for (const call of read.mock.calls) expect(call[0]).toBe('custom-minimax');
  });
  it('distinguishes decryption failure from a missing entry', () => {
    read.mockReturnValue({ found: true, error: 'Vault entry decryption failed' });
    expect(resolveProviderKeyResult('minimax', { MINIMAX_VAULT_KEY: 'custom' })).toEqual({
      source: 'none',
      reason: 'vault_error',
    });
  });
  it('does not read a whitespace-only reference', () => {
    expect(resolveProviderVaultKey('minimax', { MINIMAX_VAULT_KEY: '  ' })).toBeUndefined();
    expect(read).not.toHaveBeenCalled();
  });
});
