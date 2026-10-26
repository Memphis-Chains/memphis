import { rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

import Fastify from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';

const { audit } = vi.hoisted(() => ({ audit: vi.fn() }));
vi.mock('../../src/infra/logging/security-audit.js', () => ({ writeSecurityAudit: audit }));

import { registerVaultRoutes } from '../../src/infra/http/routes/vault.js';
import { resetActiveVault, vaultInit } from '../../src/infra/storage/rust-vault-adapter.js';
import { initializeVault } from '../../src/security/vault-boundary.js';
import { createIsolatedTestRuntime } from '../helpers/isolated-runtime.js';

const initialEnv = process.env;
const roots: string[] = [];
const sentinel = 'synthetic-private-legacy-initialization-result';
const metadata = { version: 2, did: 'did:memphis:synthetic-legacy-identity' };
const input = {
  passphrase: 'SyntheticStrongPassphrase!123',
  recovery_question: 'Synthetic question?',
  recovery_answer: 'Synthetic answer',
};

afterEach(() => {
  process.env = initialEnv;
  resetActiveVault();
  audit.mockClear();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture(data: unknown) {
  const f = createIsolatedTestRuntime(initialEnv, resolve('.'));
  roots.push(f.root);
  const bridge = join(f.root, 'legacy-bridge.cjs');
  writeFileSync(
    bridge,
    `module.exports = {
      vault_init_json: () => ${JSON.stringify(JSON.stringify({ ok: true, data }))},
      vault_encrypt: () => '', vault_decrypt: () => ''
    };`,
    { mode: 0o600 },
  );
  f.env.RUST_CHAIN_BRIDGE_PATH = bridge;
  f.env.MEMPHIS_VAULT_PEPPER = 'synthetic-legacy-initialization-pepper';
  process.env = f.env;
  return f.env;
}

async function httpInit() {
  const app = Fastify();
  registerVaultRoutes(app);
  try {
    const response = await app.inject({ method: 'POST', url: '/v1/vault/init', payload: input });
    return { status: response.statusCode, body: response.json() };
  } finally {
    await app.close();
  }
}

describe('legacy vault initialization result boundary', () => {
  it.each(['adapter', 'facade', 'http'])(
    'exports only initialization metadata through %s',
    async (surface) => {
      const env = fixture({
        ...metadata,
        success: true,
        master_key_hash: sentinel,
        error: sentinel,
        nested: { plaintext: sentinel },
      });
      let result: unknown;
      if (surface === 'adapter') result = vaultInit(input, env);
      else if (surface === 'facade') result = initializeVault(input, { surface: 'http' }, env);
      else {
        const response = await httpInit();
        expect(response.status).toBe(200);
        expect(Object.keys(response.body)).toEqual(['ok', 'vault']);
        result = response.body.vault;
      }
      expect(result).toEqual(metadata);
      expect(JSON.stringify({ result, audit: audit.mock.calls })).not.toContain(sentinel);
    },
  );

  it('retains version 1 metadata compatibility without forwarding extra fields', () => {
    const env = fixture({ ...metadata, version: 1, master_key_hash: sentinel });
    expect(vaultInit(input, env)).toEqual({ ...metadata, version: 1 });
  });

  it.each([
    [
      'private legacy Rust result without public metadata',
      { success: true, master_key_hash: sentinel },
    ],
    ['null result', null],
    ['non-string identity', { ...metadata, did: { private: sentinel } }],
    ['empty identity', { ...metadata, did: '' }],
    ['string version', { ...metadata, version: '2' }],
    ['unknown version', { ...metadata, version: 3 }],
  ])('rejects %s with a fixed public failure', async (_name, data) => {
    const env = fixture(data);
    expect(() => initializeVault(input, { surface: 'http' }, env)).toThrow(
      'Vault initialization failed; run memphis doctor to check configuration.',
    );
    const response = await httpInit();
    expect(response.status).toBe(503);
    expect(response.body).toEqual({
      ok: false,
      code: 'VAULT_INITIALIZATION_FAILED',
      error: 'Vault initialization failed; run memphis doctor to check configuration.',
    });
    expect(JSON.stringify({ response, audit: audit.mock.calls })).not.toContain(sentinel);
  });
});
