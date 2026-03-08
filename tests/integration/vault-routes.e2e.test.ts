import { describe, expect, it } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createAppContainer } from '../../src/app/container.js';
import { createHttpServer } from '../../src/infra/http/server.js';
import type { AppConfig } from '../../src/infra/config/schema.js';

function cfg(db: string, rustEnabled = false): AppConfig {
  return {
    NODE_ENV: 'test',
    HOST: '127.0.0.1',
    PORT: 0,
    LOG_LEVEL: 'error',
    DEFAULT_PROVIDER: 'local-fallback',
    SHARED_LLM_API_BASE: undefined,
    SHARED_LLM_API_KEY: undefined,
    DECENTRALIZED_LLM_API_BASE: undefined,
    DECENTRALIZED_LLM_API_KEY: undefined,
    LOCAL_FALLBACK_ENABLED: true,
    GEN_TIMEOUT_MS: 30000,
    GEN_MAX_TOKENS: 512,
    GEN_TEMPERATURE: 0.4,
    RUST_CHAIN_ENABLED: rustEnabled,
    RUST_CHAIN_BRIDGE_PATH: './crates/memphis-napi',
    DATABASE_URL: `file:${db}`,
  };
}

describe('vault routes e2e', () => {
  it('returns 400 on invalid payload and 503 while rust vault bridge is disabled', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mv4-vault-e2e-'));
    const conf = cfg(join(dir, 'vault.db'));
    const c = createAppContainer(conf);
    const app = createHttpServer(conf, c.orchestration, {
      sessionRepository: c.sessionRepository,
      generationEventRepository: c.generationEventRepository,
    });

    const invalidInit = await app.inject({
      method: 'POST',
      url: '/v1/vault/init',
      payload: {
        passphrase: '',
        recovery_question: 'x',
        recovery_answer: '',
      },
    });

    expect(invalidInit.statusCode).toBe(400);

    const init = await app.inject({
      method: 'POST',
      url: '/v1/vault/init',
      payload: {
        passphrase: 'VeryStrongPassphrase!123',
        recovery_question: 'pet?',
        recovery_answer: 'nori',
      },
    });

    expect(init.statusCode).toBe(503);

    const encrypt = await app.inject({
      method: 'POST',
      url: '/v1/vault/encrypt',
      payload: { key: 'openai_api_key', plaintext: 'secret' },
    });

    expect(encrypt.statusCode).toBe(503);

    const decrypt = await app.inject({
      method: 'POST',
      url: '/v1/vault/decrypt',
      payload: { entry: { key: 'k', encrypted: 'x', iv: 'y' } },
    });

    expect(decrypt.statusCode).toBe(503);

    await app.close();
  });

  it('persists encrypted entries when rust bridge is available', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mv4-vault-persist-'));
    const conf = cfg(join(dir, 'vault.db'), true);

    const bridgePath = join(dir, 'mock-rust-bridge.cjs');
    writeFileSync(
      bridgePath,
      `module.exports = {
  vault_init: (requestJson) => JSON.stringify({ ok: true, data: { version: 1, did: 'did:memphis:mock' } }),
  vault_encrypt: (key, plaintext) => JSON.stringify({ ok: true, data: { key, encrypted: 'plain:' + plaintext, iv: 'mock-iv' } }),
  vault_decrypt: (entryJson) => {
    const entry = JSON.parse(entryJson);
    return JSON.stringify({ ok: true, data: { plaintext: String(entry.encrypted || '').replace(/^plain:/, '') } });
  }
};`,
      'utf8',
    );

    process.env.RUST_CHAIN_ENABLED = 'true';
    process.env.RUST_CHAIN_BRIDGE_PATH = bridgePath;
    process.env.MEMPHIS_VAULT_PEPPER = 'phase1pepper-secret';
    process.env.MEMPHIS_VAULT_ENTRIES_PATH = join(dir, 'vault-entries.json');

    const c = createAppContainer(conf);
    const app = createHttpServer(conf, c.orchestration, {
      sessionRepository: c.sessionRepository,
      generationEventRepository: c.generationEventRepository,
    });

    const encrypt = await app.inject({
      method: 'POST',
      url: '/v1/vault/encrypt',
      payload: { key: 'openai_api_key', plaintext: 'secret' },
    });

    expect(encrypt.statusCode).toBe(200);

    const list = await app.inject({ method: 'GET', url: '/v1/vault/entries' });
    expect(list.statusCode).toBe(200);
    const body = list.json() as {
      count: number;
      entries: Array<{ key: string; createdAt: string; fingerprint: string; integrityOk: boolean }>;
    };
    expect(body.count).toBe(1);
    expect(body.entries[0]?.key).toBe('openai_api_key');
    expect(typeof body.entries[0]?.createdAt).toBe('string');
    expect(typeof body.entries[0]?.fingerprint).toBe('string');
    expect(body.entries[0]?.integrityOk).toBe(true);

    delete process.env.RUST_CHAIN_ENABLED;
    delete process.env.RUST_CHAIN_BRIDGE_PATH;
    delete process.env.MEMPHIS_VAULT_PEPPER;
    delete process.env.MEMPHIS_VAULT_ENTRIES_PATH;
    await app.close();
  });
});
