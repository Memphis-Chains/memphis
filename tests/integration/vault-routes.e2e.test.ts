import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createAppContainer } from '../../src/app/container.js';
import type { AppConfig } from '../../src/infra/config/schema.js';
import { createHttpServer } from '../../src/infra/http/server.js';

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
  const originalEnv = {
    RUST_CHAIN_ENABLED: process.env.RUST_CHAIN_ENABLED,
    RUST_CHAIN_BRIDGE_PATH: process.env.RUST_CHAIN_BRIDGE_PATH,
    MEMPHIS_VAULT_PEPPER: process.env.MEMPHIS_VAULT_PEPPER,
    MEMPHIS_VAULT_ENTRIES_PATH: process.env.MEMPHIS_VAULT_ENTRIES_PATH,
  };

  function restoreEnv(): void {
    if (originalEnv.RUST_CHAIN_ENABLED === undefined) delete process.env.RUST_CHAIN_ENABLED;
    else process.env.RUST_CHAIN_ENABLED = originalEnv.RUST_CHAIN_ENABLED;

    if (originalEnv.RUST_CHAIN_BRIDGE_PATH === undefined) delete process.env.RUST_CHAIN_BRIDGE_PATH;
    else process.env.RUST_CHAIN_BRIDGE_PATH = originalEnv.RUST_CHAIN_BRIDGE_PATH;

    if (originalEnv.MEMPHIS_VAULT_PEPPER === undefined) delete process.env.MEMPHIS_VAULT_PEPPER;
    else process.env.MEMPHIS_VAULT_PEPPER = originalEnv.MEMPHIS_VAULT_PEPPER;

    if (originalEnv.MEMPHIS_VAULT_ENTRIES_PATH === undefined)
      delete process.env.MEMPHIS_VAULT_ENTRIES_PATH;
    else process.env.MEMPHIS_VAULT_ENTRIES_PATH = originalEnv.MEMPHIS_VAULT_ENTRIES_PATH;
  }

  beforeEach(() => {
    delete process.env.RUST_CHAIN_ENABLED;
    delete process.env.RUST_CHAIN_BRIDGE_PATH;
    delete process.env.MEMPHIS_VAULT_PEPPER;
    delete process.env.MEMPHIS_VAULT_ENTRIES_PATH;
  });

  afterEach(() => {
    restoreEnv();
  });

  it('returns 400 on invalid payload and 503 while rust vault bridge is disabled', async () => {
    process.env.MEMPHIS_API_TOKEN = 'test-token';
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
      headers: { authorization: 'Bearer test-token' },
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
      headers: { authorization: 'Bearer test-token' },
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
      headers: { authorization: 'Bearer test-token' },
      payload: { key: 'openai_api_key', plaintext: 'secret' },
    });

    expect(encrypt.statusCode).toBe(503);

    const decrypt = await app.inject({
      method: 'POST',
      url: '/v1/vault/decrypt',
      headers: { authorization: 'Bearer test-token' },
      payload: { entry: { key: 'k', encrypted: 'x', iv: 'y' } },
    });

    expect(decrypt.statusCode).toBe(503);

    await app.close();
  });

  it('persists encrypted entries when rust bridge is available', async () => {
    process.env.MEMPHIS_API_TOKEN = 'test-token';
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
      headers: { authorization: 'Bearer test-token' },
      payload: { key: 'openai_api_key', plaintext: 'secret' },
    });

    expect(encrypt.statusCode).toBe(200);

    const list = await app.inject({ method: 'GET', url: '/v1/vault/entries', headers: { authorization: 'Bearer test-token' } });
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
