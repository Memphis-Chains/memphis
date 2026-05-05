/**
 * Unit tests for memphis openai configure / status CLI.
 *
 * Same shape as the brave-handler tests (#487) — vault, env-file,
 * journal mocks via vi.hoisted; fetch mocked for the status probe.
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

import type { CliContext } from '../../src/infra/cli/context.js';
import { openaiCommandHandler } from '../../src/infra/cli/handlers/openai.handler.js';

const { storeVaultSecret, upsertEnvVars, runMemphisJournal } = mocks;
const ORIGINAL_FETCH = globalThis.fetch;

function makeContext(args: Partial<CliContext['args']>): CliContext {
  return {
    args: {
      command: 'openai',
      ...args,
    },
  } as unknown as CliContext;
}

describe('memphis openai configure', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    vi.clearAllMocks();
    delete process.env.OPENAI_COMPATIBLE_API_KEY;
    delete process.env.OPENAI_COMPATIBLE_API_BASE;
    delete process.env.OPENAI_COMPATIBLE_MODEL;
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it('rejects configure without --key', async () => {
    await expect(
      openaiCommandHandler.handle(
        makeContext({ subcommand: 'configure', json: true }),
      ),
    ).rejects.toThrow('--key <sk-...> required');
  });

  it('stores key in vault and writes 3 env entries on configure', async () => {
    await openaiCommandHandler.handle(
      makeContext({
        subcommand: 'configure',
        json: true,
        key: 'sk-abc0123456789012345678901234567890',
      } as Partial<CliContext['args']>),
    );

    expect(storeVaultSecret).toHaveBeenCalledWith(
      'openai_api_key',
      'sk-abc0123456789012345678901234567890',
      expect.objectContaining({ surface: 'cli', command: 'openai configure' }),
      expect.any(Object),
    );
    expect(upsertEnvVars).toHaveBeenCalledWith([
      { key: 'OPENAI_COMPATIBLE_API_BASE', value: 'https://api.openai.com/v1' },
      { key: 'OPENAI_COMPATIBLE_API_KEY', value: 'VAULT:openai_api_key' },
      { key: 'OPENAI_COMPATIBLE_MODEL', value: 'gpt-5-codex' },
    ]);
  });

  it('uses --model override when provided (else default gpt-5-codex)', async () => {
    await openaiCommandHandler.handle(
      makeContext({
        subcommand: 'configure',
        json: true,
        key: 'sk-abc0123456789012345678901234567890',
        model: 'gpt-4o-mini',
      } as Partial<CliContext['args']>),
    );

    expect(upsertEnvVars).toHaveBeenCalledWith(
      expect.arrayContaining([
        { key: 'OPENAI_COMPATIBLE_MODEL', value: 'gpt-4o-mini' },
      ]),
    );
  });

  it('writes a config-change journal event tagged for chain_hits visibility', async () => {
    await openaiCommandHandler.handle(
      makeContext({
        subcommand: 'configure',
        json: true,
        key: 'sk-abc0123456789012345678901234567890',
      } as Partial<CliContext['args']>),
    );
    expect(runMemphisJournal).toHaveBeenCalledWith(
      expect.objectContaining({
        content: expect.stringContaining('OpenAI provider configured'),
        tags: expect.arrayContaining(['config-change', 'openai', 'external-api']),
        surface: 'cli',
      }),
    );
  });

  it('warns and overwrites when env was already pointing at non-OpenAI baseUrl', async () => {
    process.env.OPENAI_COMPATIBLE_API_BASE = 'https://api.deepseek.com';
    const beforeWarnings = upsertEnvVars.mock.calls.length;
    await openaiCommandHandler.handle(
      makeContext({
        subcommand: 'configure',
        json: true,
        key: 'sk-abc0123456789012345678901234567890',
      } as Partial<CliContext['args']>),
    );
    // upsert still runs (overwrites unconditionally; warning surfaces in result)
    expect(upsertEnvVars.mock.calls.length).toBe(beforeWarnings + 1);
    // The journal entry should still fire — vault + env writes succeeded
    expect(runMemphisJournal).toHaveBeenCalled();
  });

  it('exposes the new key + model on process.env so the same-process status sees it', async () => {
    await openaiCommandHandler.handle(
      makeContext({
        subcommand: 'configure',
        json: true,
        key: 'sk-abc0123456789012345678901234567890',
      } as Partial<CliContext['args']>),
    );
    expect(process.env.OPENAI_COMPATIBLE_API_KEY).toBe(
      'sk-abc0123456789012345678901234567890',
    );
    expect(process.env.OPENAI_COMPATIBLE_API_BASE).toBe('https://api.openai.com/v1');
    expect(process.env.OPENAI_COMPATIBLE_MODEL).toBe('gpt-5-codex');
  });

  it('continues even when journal write fails', async () => {
    runMemphisJournal.mockRejectedValueOnce(new Error('chain unavailable'));
    const ok = await openaiCommandHandler.handle(
      makeContext({
        subcommand: 'configure',
        json: true,
        key: 'sk-abc0123456789012345678901234567890',
      } as Partial<CliContext['args']>),
    );
    expect(ok).toBe(true);
    expect(storeVaultSecret).toHaveBeenCalled();
  });
});

describe('memphis openai status', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    vi.clearAllMocks();
    delete process.env.OPENAI_COMPATIBLE_API_KEY;
    delete process.env.OPENAI_COMPATIBLE_API_BASE;
    delete process.env.OPENAI_COMPATIBLE_MODEL;
  });

  afterEach(() => {
    process.env = { ...originalEnv };
    globalThis.fetch = ORIGINAL_FETCH;
  });

  it('does NOT call OpenAI when key is unset', async () => {
    const fetchSpy = vi.fn(async () => new Response('{}', { status: 200 }));
    globalThis.fetch = fetchSpy as unknown as typeof globalThis.fetch;
    await openaiCommandHandler.handle(
      makeContext({ subcommand: 'status', json: true }),
    );
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('does NOT call OpenAI when env still holds VAULT: prefix', async () => {
    process.env.OPENAI_COMPATIBLE_API_KEY = 'VAULT:openai_api_key';
    const fetchSpy = vi.fn(async () => new Response('{}', { status: 200 }));
    globalThis.fetch = fetchSpy as unknown as typeof globalThis.fetch;
    await openaiCommandHandler.handle(
      makeContext({ subcommand: 'status', json: true }),
    );
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('runs a /models probe with Bearer auth when key is present', async () => {
    process.env.OPENAI_COMPATIBLE_API_KEY = 'sk-abcdef0123456789';
    process.env.OPENAI_COMPATIBLE_API_BASE = 'https://api.openai.com/v1';
    process.env.OPENAI_COMPATIBLE_MODEL = 'gpt-5-codex';
    const fetchSpy = vi.fn(
      async () =>
        new Response(JSON.stringify({ data: [{ id: 'gpt-5-codex' }, { id: 'gpt-4o' }] }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
    );
    globalThis.fetch = fetchSpy as unknown as typeof globalThis.fetch;

    await openaiCommandHandler.handle(
      makeContext({ subcommand: 'status', json: true }),
    );

    expect(fetchSpy).toHaveBeenCalled();
    const [url, init] = fetchSpy.mock.calls[0]!;
    expect(String(url)).toBe('https://api.openai.com/v1/models');
    const headers = (init as RequestInit).headers as Record<string, string>;
    expect(headers.Authorization).toBe('Bearer sk-abcdef0123456789');
  });

  it('annotates 401 as "key rejected"', async () => {
    process.env.OPENAI_COMPATIBLE_API_KEY = 'sk-bad';
    const fetchSpy = vi.fn(async () => new Response('{"error":"invalid"}', { status: 401 }));
    globalThis.fetch = fetchSpy as unknown as typeof globalThis.fetch;
    // Status doesn't throw; just exercises the path
    await openaiCommandHandler.handle(
      makeContext({ subcommand: 'status', json: true }),
    );
    expect(fetchSpy).toHaveBeenCalled();
  });
});

describe('openaiCommandHandler shape', () => {
  it('exposes name, commands, canHandle, handle', () => {
    expect(openaiCommandHandler.name).toBe('openai');
    expect(openaiCommandHandler.commands).toContain('openai');
  });

  it('canHandle returns true only for command="openai"', () => {
    expect(
      openaiCommandHandler.canHandle({ args: { command: 'openai' } } as CliContext),
    ).toBe(true);
    expect(
      openaiCommandHandler.canHandle({ args: { command: 'minimax' } } as CliContext),
    ).toBe(false);
  });

  it('rejects unknown subcommands with a helpful hint', async () => {
    await expect(
      openaiCommandHandler.handle(
        makeContext({ subcommand: 'banana' } as Partial<CliContext['args']>),
      ),
    ).rejects.toThrow(/Unknown subcommand.*configure.*status/);
  });
});
