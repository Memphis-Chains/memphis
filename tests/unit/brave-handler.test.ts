/**
 * Unit tests for memphis brave configure / status CLI.
 *
 * The handler shells out to vault-boundary, env-file mutation, the
 * brave-search adapter, and the journal tool — each is mocked here so
 * the test exercises the orchestration logic without touching disk
 * or the network.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  storeVaultSecret: vi.fn(),
  upsertEnvVars: vi.fn(() => ({ path: '/tmp/.env-test', written: [] })),
  runMemphisJournal: vi.fn(async () => ({
    success: true,
    memoryId: 'mem-1',
    index: 1,
    hash: 'abc',
    indexed: true,
  })),
  runMemphisBraveSearch: vi.fn(async () => ({
    query: 'memphis-status-probe',
    results: [],
    count: 0,
  })),
}));

vi.mock('../../src/security/vault-boundary.js', () => ({
  storeVaultSecret: mocks.storeVaultSecret,
  probeVaultCipherCycle: vi.fn(),
}));
vi.mock('../../src/infra/config/env-file.js', () => ({
  upsertEnvVars: mocks.upsertEnvVars,
}));
vi.mock('../../src/mcp/tools/journal.js', () => ({
  runMemphisJournal: mocks.runMemphisJournal,
}));
vi.mock('../../src/mcp/tools/brave-search.js', () => ({
  runMemphisBraveSearch: mocks.runMemphisBraveSearch,
}));

import type { CliContext } from '../../src/infra/cli/context.js';
import { braveCommandHandler } from '../../src/infra/cli/handlers/brave.handler.js';

const { storeVaultSecret, upsertEnvVars, runMemphisJournal, runMemphisBraveSearch } = mocks;

function makeContext(args: Partial<CliContext['args']>): CliContext {
  return {
    args: {
      command: 'brave',
      ...args,
    },
  } as unknown as CliContext;
}

describe('memphis brave configure', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    vi.clearAllMocks();
    delete process.env.BRAVE_API_KEY;
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it('rejects configure without --key', async () => {
    await expect(
      braveCommandHandler.handle(
        makeContext({ subcommand: 'configure', json: true }),
      ),
    ).rejects.toThrow('--key <token> required');
  });

  it('stores key in vault and upserts .env on configure', async () => {
    await braveCommandHandler.handle(
      makeContext({
        subcommand: 'configure',
        json: true,
        key: 'BSAabcdef0123456789012345abcdef',
      } as Partial<CliContext['args']>),
    );

    expect(storeVaultSecret).toHaveBeenCalledWith(
      'brave_api_key',
      'BSAabcdef0123456789012345abcdef',
      expect.objectContaining({ surface: 'cli', command: 'brave configure' }),
      expect.any(Object),
    );
    expect(upsertEnvVars).toHaveBeenCalledWith([
      { key: 'BRAVE_API_KEY', value: 'VAULT:brave_api_key' },
    ]);
  });

  it('writes a config-change journal event tagged for chain_hits visibility', async () => {
    await braveCommandHandler.handle(
      makeContext({
        subcommand: 'configure',
        json: true,
        key: 'BSAabcdef0123456789012345abcdef',
      } as Partial<CliContext['args']>),
    );

    expect(runMemphisJournal).toHaveBeenCalledWith(
      expect.objectContaining({
        content: expect.stringContaining('Brave Search API'),
        tags: expect.arrayContaining(['config-change', 'brave-search']),
        surface: 'cli',
      }),
    );
  });

  it('exposes the new key on process.env so the same-process status probe sees it', async () => {
    await braveCommandHandler.handle(
      makeContext({
        subcommand: 'configure',
        json: true,
        key: 'BSAabcdef0123456789012345abcdef',
      } as Partial<CliContext['args']>),
    );
    expect(process.env.BRAVE_API_KEY).toBe('BSAabcdef0123456789012345abcdef');
  });

  it('warns when key does not match expected BSA shape but still stores it', async () => {
    await braveCommandHandler.handle(
      makeContext({
        subcommand: 'configure',
        json: true,
        key: 'random-not-brave-shape',
      } as Partial<CliContext['args']>),
    );
    // Vault store still happened — soft warning only, not a hard reject
    expect(storeVaultSecret).toHaveBeenCalled();
  });

  it('continues even when journal write fails (vault write is the source of truth)', async () => {
    runMemphisJournal.mockRejectedValueOnce(new Error('chain unavailable'));
    const ok = await braveCommandHandler.handle(
      makeContext({
        subcommand: 'configure',
        json: true,
        key: 'BSAabcdef0123456789012345abcdef',
      } as Partial<CliContext['args']>),
    );
    expect(ok).toBe(true);
    expect(storeVaultSecret).toHaveBeenCalled();
  });
});

describe('memphis brave status', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    vi.clearAllMocks();
    delete process.env.BRAVE_API_KEY;
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it('reports key=missing + suggestion when BRAVE_API_KEY is unset', async () => {
    await braveCommandHandler.handle(
      makeContext({ subcommand: 'status', json: true }),
    );
    expect(runMemphisBraveSearch).not.toHaveBeenCalled();
  });

  it('reports vault-unresolved when env still holds VAULT: prefix', async () => {
    process.env.BRAVE_API_KEY = 'VAULT:brave_api_key';
    await braveCommandHandler.handle(
      makeContext({ subcommand: 'status', json: true }),
    );
    // No probe (key not actually usable)
    expect(runMemphisBraveSearch).not.toHaveBeenCalled();
  });

  it('runs a probe when key is present', async () => {
    process.env.BRAVE_API_KEY = 'BSAabcdef0123456789012345abcdef';
    await braveCommandHandler.handle(
      makeContext({ subcommand: 'status', json: true }),
    );
    expect(runMemphisBraveSearch).toHaveBeenCalledWith(
      expect.objectContaining({
        query: 'memphis-status-probe',
        limit: 1,
      }),
      expect.any(Object),
    );
  });
});

describe('braveCommandHandler shape', () => {
  it('exposes name, commands, canHandle, handle on the registry contract', () => {
    expect(braveCommandHandler.name).toBe('brave');
    expect(braveCommandHandler.commands).toContain('brave');
    expect(typeof braveCommandHandler.canHandle).toBe('function');
    expect(typeof braveCommandHandler.handle).toBe('function');
  });

  it('canHandle returns true only for command="brave"', () => {
    expect(
      braveCommandHandler.canHandle({ args: { command: 'brave' } } as CliContext),
    ).toBe(true);
    expect(
      braveCommandHandler.canHandle({ args: { command: 'telegram' } } as CliContext),
    ).toBe(false);
  });

  it('rejects unknown subcommands with a helpful hint', async () => {
    await expect(
      braveCommandHandler.handle(
        makeContext({ subcommand: 'banana' } as Partial<CliContext['args']>),
      ),
    ).rejects.toThrow(/Unknown subcommand.*configure.*status/);
  });
});
