import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../src/security/vault-boundary.js', () => ({
  storeVaultSecret: vi.fn(),
}));

vi.mock('../../src/infra/config/env-file.js', () => ({
  upsertEnvVars: vi.fn(() => ({ path: '/tmp/.env', updated: [], added: [] })),
}));

import { enrollProviderKey } from '../../src/infra/cli/commands/provider.js';
import { upsertEnvVars } from '../../src/infra/config/env-file.js';
import { storeVaultSecret } from '../../src/security/vault-boundary.js';

const mockedStore = vi.mocked(storeVaultSecret);
const mockedUpsert = vi.mocked(upsertEnvVars);

beforeEach(() => {
  vi.clearAllMocks();
  mockedUpsert.mockReturnValue({
    path: '/tmp/.env',
    updated: [],
    added: [],
  } as unknown as ReturnType<typeof upsertEnvVars>);
});

describe('enrollProviderKey', () => {
  it('stores vault secret and upserts env ref for a vault-key provider', async () => {
    const result = await enrollProviderKey('anthropic', 'sk-ant-very-long-key', {});
    expect(result.ok).toBe(true);
    expect(result.vaultKey).toBe('anthropic_api_key');
    expect(result.envRef).toBe('ANTHROPIC_VAULT_KEY=anthropic_api_key');
    expect(mockedStore).toHaveBeenCalledWith(
      'anthropic_api_key',
      'sk-ant-very-long-key',
      expect.objectContaining({ surface: 'cli', command: 'provider add' }),
      expect.anything(),
    );
    expect(mockedUpsert).toHaveBeenCalledWith([
      { key: 'ANTHROPIC_VAULT_KEY', value: 'anthropic_api_key' },
    ]);
    expect(result.nextSteps?.some((s) => s.includes('memphis auth anthropic'))).toBe(true);
  });

  it('uses VAULT: prefix style for shared-llm', async () => {
    const result = await enrollProviderKey('shared-llm', 'shared-key-1234567', {});
    expect(result.envRef).toBe('SHARED_LLM_API_KEY=VAULT:shared_llm_api_key');
    expect(result.nextSteps?.some((s) => s.includes('SHARED_LLM_API_BASE'))).toBe(true);
  });

  it('rejects an unsupported provider', async () => {
    await expect(
      enrollProviderKey('openai' as Parameters<typeof enrollProviderKey>[0], 'key12345', {}),
    ).rejects.toThrow(/Unsupported provider: openai/);
    expect(mockedStore).not.toHaveBeenCalled();
  });

  it('rejects an empty or short api key', async () => {
    await expect(enrollProviderKey('minimax', '', {})).rejects.toThrow(/cannot be empty/);
    await expect(enrollProviderKey('minimax', 'short', {})).rejects.toThrow(/too short/);
    expect(mockedStore).not.toHaveBeenCalled();
  });

  it('surfaces a vault-not-initialized error with a friendly hint', async () => {
    mockedStore.mockImplementation(() => {
      throw new Error('vault not initialized');
    });
    await expect(enrollProviderKey('minimax', 'valid-key-1234', {})).rejects.toThrow(
      /memphis vault init/,
    );
  });
});
