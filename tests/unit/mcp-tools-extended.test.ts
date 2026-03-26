import { describe, expect, it, vi, beforeEach } from 'vitest';

import { runMemphisCaseAppend, runMemphisCaseQuery } from '../../src/mcp/tools/case-entry.js';
import { runMemphisEmbedSearch, runMemphisEmbedStore } from '../../src/mcp/tools/embed.js';
import { runMemphisSend } from '../../src/mcp/tools/send.js';
import { runMemphisVaultGet, runMemphisVaultList } from '../../src/mcp/tools/vault-get.js';

vi.mock('../../src/infra/auth/operator-gate.js', () => ({
  isSessionAuthorized: vi.fn(() => true),
  authorizeSession: vi.fn(),
}));

vi.mock('../../src/infra/storage/rust-embed-adapter.js', () => ({
  embedStore: vi.fn(),
  embedSearch: vi.fn(),
}));

vi.mock('../../src/infra/storage/rust-vault-adapter.js', () => ({
  vaultDecrypt: vi.fn(),
  getRustVaultAdapterStatus: vi.fn(() => ({
    rustEnabled: false,
    bridgeLoaded: false,
    vaultApiAvailable: false,
  })),
  getRustEmbedAdapterStatus: vi.fn(() => ({
    rustEnabled: false,
    bridgeLoaded: false,
    embedApiAvailable: false,
  })),
}));

vi.mock('../../src/infra/storage/vault-entry-store.js', () => ({
  getLatestVaultEntry: vi.fn(),
  listVaultEntries: vi.fn(() => []),
  verifyVaultEntry: vi.fn(() => true),
}));

describe('mcp tools — case-entry', () => {
  it('appends a case entry via adapter', async () => {
    const adapter = {
      appendCaseEntry: vi.fn(async () => ({
        ok: true,
        index: 5,
        hash: 'abc123',
        chain: 'cases',
      })),
      queryCases: vi.fn(),
    };
    const entry = { type: 'audit', source: 'test', data: { key: 'value' } };
    const result = await runMemphisCaseAppend({ entry: entry as never }, { adapter: adapter as never });
    expect(adapter.appendCaseEntry).toHaveBeenCalledWith(entry);
    expect(result).toMatchObject({ ok: true, index: 5 });
  });

  it('queries cases via adapter', async () => {
    const adapter = {
      appendCaseEntry: vi.fn(),
      queryCases: vi.fn(async () => ({
        count: 2,
        cases: [{ type: 'audit' }, { type: 'decision' }],
      })),
    };
    const query = { type: 'audit', limit: 10 };
    const result = await runMemphisCaseQuery({ query: query as never }, { adapter: adapter as never });
    expect(adapter.queryCases).toHaveBeenCalledWith(query);
    expect(result.count).toBe(2);
  });
});

describe('mcp tools — embed', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('stores text in embedding index', async () => {
    const { embedStore } = await import('../../src/infra/storage/rust-embed-adapter.js');
    vi.mocked(embedStore).mockReturnValue({ id: 'doc-1', count: 10, dim: 384, provider: 'ollama' });

    const result = runMemphisEmbedStore({ id: 'doc-1', text: 'hello world' });
    expect(result.stored).toBe(true);
    expect(result.id).toBe('doc-1');
    expect(result.dim).toBe(384);
  });

  it('returns error on embed store failure', async () => {
    const { embedStore } = await import('../../src/infra/storage/rust-embed-adapter.js');
    vi.mocked(embedStore).mockImplementation(() => {
      throw new Error('Rust bridge unavailable');
    });

    const result = runMemphisEmbedStore({ id: 'doc-1', text: 'hello' });
    expect(result.stored).toBe(false);
    expect(result.error).toContain('Rust bridge unavailable');
  });

  it('searches embedding index', async () => {
    const { embedSearch } = await import('../../src/infra/storage/rust-embed-adapter.js');
    vi.mocked(embedSearch).mockReturnValue({
      query: 'test',
      count: 1,
      hits: [{ id: '1', score: 0.95, text_preview: 'found it' }],
    });

    const result = runMemphisEmbedSearch({ query: 'test', topK: 3 });
    expect(result.count).toBe(1);
    expect(result.hits[0]!.score).toBe(0.95);
  });

  it('returns empty on embed search failure', async () => {
    const { embedSearch } = await import('../../src/infra/storage/rust-embed-adapter.js');
    vi.mocked(embedSearch).mockImplementation(() => {
      throw new Error('not available');
    });

    const result = runMemphisEmbedSearch({ query: 'test' });
    expect(result.count).toBe(0);
    expect(result.hits).toEqual([]);
    expect(result.error).toContain('not available');
  });
});

describe('mcp tools — vault-get', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('returns not found for missing key', async () => {
    const { getLatestVaultEntry } = await import('../../src/infra/storage/vault-entry-store.js');
    vi.mocked(getLatestVaultEntry).mockReturnValue(undefined);

    const result = runMemphisVaultGet({ key: 'missing' });
    expect(result.found).toBe(false);
    expect(result.key).toBe('missing');
  });

  it('decrypts and returns vault entry', async () => {
    const { getLatestVaultEntry } = await import('../../src/infra/storage/vault-entry-store.js');
    const { vaultDecrypt } = await import('../../src/infra/storage/rust-vault-adapter.js');

    vi.mocked(getLatestVaultEntry).mockReturnValue({
      key: 'api-key',
      encrypted: 'ZW5j',
      iv: 'bg==',
      fingerprint: 'fp-1',
      createdAt: '2026-01-01T00:00:00Z',
    } as never);
    vi.mocked(vaultDecrypt).mockReturnValue('secret-value');

    const result = runMemphisVaultGet({ key: 'api-key' });
    expect(result.found).toBe(true);
    expect(result.plaintext).toBe('secret-value');
    expect(result.createdAt).toBe('2026-01-01T00:00:00Z');
  });

  it('returns error on decryption failure', async () => {
    const { getLatestVaultEntry } = await import('../../src/infra/storage/vault-entry-store.js');
    const { vaultDecrypt } = await import('../../src/infra/storage/rust-vault-adapter.js');

    vi.mocked(getLatestVaultEntry).mockReturnValue({
      key: 'broken',
      encrypted: 'ZW5j',
      iv: 'bg==',
      fingerprint: 'fp-2',
      createdAt: '2026-01-01T00:00:00Z',
    } as never);
    vi.mocked(vaultDecrypt).mockImplementation(() => {
      throw new Error('bad key');
    });

    const result = runMemphisVaultGet({ key: 'broken' });
    expect(result.found).toBe(true);
    expect(result.error).toBe('Vault entry decryption failed');
  });

  it('lists vault entry keys with deduplication', async () => {
    const { listVaultEntries } = await import('../../src/infra/storage/vault-entry-store.js');
    vi.mocked(listVaultEntries).mockReturnValue([
      { key: 'a', createdAt: '2026-01-01T00:00:00Z', fingerprint: 'fpa', encrypted: 'x', iv: 'y' },
      { key: 'a', createdAt: '2026-01-02T00:00:00Z', fingerprint: 'fpa2', encrypted: 'x', iv: 'y' },
      { key: 'b', createdAt: '2026-01-01T00:00:00Z', fingerprint: 'fpb', encrypted: 'x', iv: 'y' },
    ] as never);

    const result = runMemphisVaultList();
    expect(result.count).toBe(2);
    expect(result.keys.map((k) => k.key)).toEqual(['a', 'b']);
    expect(result.keys[0]!.createdAt).toBe('2026-01-02T00:00:00Z');
  });
});

describe('mcp tools — send', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    delete process.env.TELEGRAM_BOT_TOKEN;
    delete process.env.TELEGRAM_CHAT_ID;
  });

  it('rejects unsupported channels', async () => {
    const result = await runMemphisSend({ channel: 'slack' as never, message: 'hi' });
    expect(result.sent).toBe(false);
    expect(result.error).toContain('Unsupported channel');
  });

  it('returns error when TELEGRAM_BOT_TOKEN not set', async () => {
    const result = await runMemphisSend({ channel: 'telegram', message: 'hi' });
    expect(result.sent).toBe(false);
    expect(result.error).toContain('TELEGRAM_BOT_TOKEN');
  });

  it('returns error when no chat ID available', async () => {
    process.env.TELEGRAM_BOT_TOKEN = 'test-token';
    const result = await runMemphisSend({ channel: 'telegram', message: 'hi' });
    expect(result.sent).toBe(false);
    expect(result.error).toContain('chat ID');
  });

  it('sends message via Telegram API', async () => {
    process.env.TELEGRAM_BOT_TOKEN = 'test-token';
    process.env.TELEGRAM_CHAT_ID = '12345';

    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ result: { message_id: 42 } }),
      }),
    );

    const result = await runMemphisSend({ channel: 'telegram', message: 'hello' });
    expect(result.sent).toBe(true);
    expect(result.messageId).toBe(42);
    expect(vi.mocked(fetch)).toHaveBeenCalledWith(
      'https://api.telegram.org/bottest-token/sendMessage',
      expect.objectContaining({ method: 'POST' }),
    );
  });

  it('handles Telegram API errors', async () => {
    process.env.TELEGRAM_BOT_TOKEN = 'test-token';
    process.env.TELEGRAM_CHAT_ID = '12345';

    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: false,
        status: 400,
        text: async () => 'Bad Request',
      }),
    );

    const result = await runMemphisSend({ channel: 'telegram', message: 'hello' });
    expect(result.sent).toBe(false);
    expect(result.error).toContain('400');
  });
});
