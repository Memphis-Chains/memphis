import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../src/security/vault-boundary.js', () => ({
  storeVaultSecret: vi.fn(),
  probeVaultCipherCycle: vi.fn(() => ({ ok: true })),
}));

vi.mock('../../src/infra/config/env-file.js', () => ({
  upsertEnvVars: vi.fn(() => ({ path: '/tmp/.env', updated: [], added: [] })),
}));

import { runTelegramSetup } from '../../src/infra/cli/commands/setup-telegram.js';
import { upsertEnvVars } from '../../src/infra/config/env-file.js';
import {
  probeVaultCipherCycle,
  storeVaultSecret,
} from '../../src/security/vault-boundary.js';

const mockedStore = vi.mocked(storeVaultSecret);
const mockedProbe = vi.mocked(probeVaultCipherCycle);
const mockedUpsert = vi.mocked(upsertEnvVars);

function makeFetchOk(botInfo: { id: number; username: string }): typeof fetch {
  return (async () => ({
    ok: true,
    async json() {
      return { ok: true, result: botInfo };
    },
  })) as unknown as typeof fetch;
}

function makeFetchFail(): typeof fetch {
  return (async () => ({
    ok: false,
    async json() {
      return { ok: false };
    },
  })) as unknown as typeof fetch;
}

beforeEach(() => {
  vi.clearAllMocks();
  mockedProbe.mockReturnValue({ ok: true });
  mockedUpsert.mockReturnValue({
    path: '/tmp/.env',
    updated: [],
    added: [],
  } as unknown as ReturnType<typeof upsertEnvVars>);
});

describe('runTelegramSetup', () => {
  it('stores token in vault, writes env refs, and reports bot info on happy path', async () => {
    const result = await runTelegramSetup({
      botToken: '1234567:AAAaaa-bbb-ccc-ddd-eee-fff-ggg-hhh',
      allowedUserIds: '111111, 222222',
      fetchImpl: makeFetchOk({ id: 42, username: 'memphis_bot' }),
    });

    expect(result.ok).toBe(true);
    expect(result.vaultKey).toBe('telegram_bot_token');
    expect(result.botInfo).toEqual({ id: 42, username: 'memphis_bot' });
    expect(result.allowedUserIds).toEqual(['111111', '222222']);
    expect(result.envRefs).toContain('MEMPHIS_TELEGRAM_BOT_TOKEN=VAULT:telegram_bot_token');
    expect(result.envRefs).toContain('MEMPHIS_TELEGRAM_ALLOWED_USER_IDS=111111,222222');
    expect(mockedStore).toHaveBeenCalledWith(
      'telegram_bot_token',
      '1234567:AAAaaa-bbb-ccc-ddd-eee-fff-ggg-hhh',
      expect.objectContaining({ surface: 'cli', command: 'setup telegram' }),
      expect.anything(),
    );
    expect(result.warnings).toHaveLength(0);
  });

  it('warns when bot token shape is off', async () => {
    const result = await runTelegramSetup({
      botToken: 'not-a-telegram-token',
      allowedUserIds: '1',
      skipProbe: true,
    });
    expect(result.warnings.some((w) => w.includes('<id>:<secret>'))).toBe(true);
  });

  it('warns when no allowed user ids are provided', async () => {
    const result = await runTelegramSetup({
      botToken: '1234567:AAAaaa-bbb-ccc-ddd-eee-fff-ggg-hhh',
      skipProbe: true,
    });
    expect(result.allowedUserIds).toEqual([]);
    expect(result.warnings.some((w) => w.includes('MEMPHIS_TELEGRAM_ALLOWED_USER_IDS'))).toBe(true);
    expect(result.manualSteps.some((s) => s.includes('memphis setup telegram'))).toBe(true);
  });

  it('rejects non-numeric allowed user ids', async () => {
    await expect(
      runTelegramSetup({
        botToken: '1234567:AAAaaa-bbb-ccc-ddd-eee-fff-ggg-hhh',
        allowedUserIds: '111,abc',
        skipProbe: true,
      }),
    ).rejects.toThrow(/numeric/);
  });

  it('requires --bot-token', async () => {
    await expect(runTelegramSetup({})).rejects.toThrow(/--bot-token/);
  });

  it('fails fast when vault is not ready', async () => {
    mockedProbe.mockReturnValue({ ok: false, error: 'vault not initialized' });
    await expect(
      runTelegramSetup({
        botToken: '1234567:AAAaaa-bbb-ccc-ddd-eee-fff-ggg-hhh',
        allowedUserIds: '111',
        skipProbe: true,
      }),
    ).rejects.toThrow(/memphis init/);
  });

  it('warns when the getMe probe cannot verify the token', async () => {
    const result = await runTelegramSetup({
      botToken: '1234567:AAAaaa-bbb-ccc-ddd-eee-fff-ggg-hhh',
      allowedUserIds: '111',
      fetchImpl: makeFetchFail(),
    });
    expect(result.botInfo).toBeUndefined();
    expect(result.warnings.some((w) => w.includes('getMe'))).toBe(true);
  });
});
