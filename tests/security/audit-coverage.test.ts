import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { createAppContainer } from '../../src/app/container.js';
import type { AppConfig } from '../../src/infra/config/schema.js';
import { createHttpServer } from '../../src/infra/http/server.js';

function makeConfig(): AppConfig {
  const dir = mkdtempSync(join(tmpdir(), 'memphis-security-audit-'));
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
    RUST_CHAIN_ENABLED: false,
    RUST_CHAIN_BRIDGE_PATH: './crates/memphis-napi',
    DATABASE_URL: `file:${join(dir, 'audit.db')}`,
  };
}

describe('security: audit coverage', () => {
  it('writes audit events for /api/decide, /api/recall and /v1/vault/*', async () => {
    process.env.MEMPHIS_API_TOKEN = 'test-token';
    const config = makeConfig();
    const container = createAppContainer(config);
    const app = createHttpServer(config, container.orchestration, {
      sessionRepository: container.sessionRepository,
      generationEventRepository: container.generationEventRepository,
    });

    const auditPath = join(
      mkdtempSync(join(tmpdir(), 'memphis-audit-log-')),
      'security-audit.jsonl',
    );
    process.env.MEMPHIS_SECURITY_AUDIT_LOG_PATH = auditPath;

    const recall = await app.inject({ method: 'POST', url: '/api/recall', headers: { authorization: 'Bearer test-token' }, payload: { limit: 5 } });
    expect(recall.statusCode).toBe(400);

    const decide = await app.inject({
      method: 'POST',
      url: '/api/decide',
      headers: { authorization: 'Bearer test-token' },
      payload: { title: 'x' },
    });
    expect(decide.statusCode).toBe(400);

    const vaultInit = await app.inject({ method: 'POST', url: '/v1/vault/init', headers: { authorization: 'Bearer test-token' }, payload: {} });
    expect(vaultInit.statusCode).toBe(400);

    const vaultEncrypt = await app.inject({
      method: 'POST',
      url: '/v1/vault/encrypt',
      headers: { authorization: 'Bearer test-token' },
      payload: {},
    });
    expect(vaultEncrypt.statusCode).toBe(400);

    const vaultDecrypt = await app.inject({
      method: 'POST',
      url: '/v1/vault/decrypt',
      headers: { authorization: 'Bearer test-token' },
      payload: {},
    });
    expect(vaultDecrypt.statusCode).toBe(400);

    const vaultEntries = await app.inject({ method: 'GET', url: '/v1/vault/entries', headers: { authorization: 'Bearer test-token' } });
    expect(vaultEntries.statusCode).toBe(200);

    const lines = readFileSync(auditPath, 'utf8')
      .trim()
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line) as { action: string; status: string });

    expect(lines.some((line) => line.action === 'recall.query' && line.status === 'blocked')).toBe(
      true,
    );
    expect(
      lines.some((line) => line.action === 'decision.append' && line.status === 'blocked'),
    ).toBe(true);
    expect(lines.some((line) => line.action === 'vault.init' && line.status === 'blocked')).toBe(
      true,
    );
    expect(lines.some((line) => line.action === 'vault.encrypt' && line.status === 'blocked')).toBe(
      true,
    );
    expect(lines.some((line) => line.action === 'vault.decrypt' && line.status === 'blocked')).toBe(
      true,
    );
    expect(
      lines.some((line) => line.action === 'vault.entries.read' && line.status === 'allowed'),
    ).toBe(true);

    await app.close();
    delete process.env.MEMPHIS_SECURITY_AUDIT_LOG_PATH;
  });
});
