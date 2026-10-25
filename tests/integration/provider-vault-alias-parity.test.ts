import { createCipheriv } from 'node:crypto';
import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { afterEach, expect, it } from 'vitest';

import { resetActiveVault } from '../../src/infra/storage/rust-vault-adapter.js';
import { resolveProviderKeyResult } from '../../src/providers/index.js';
import { createIsolatedTestRuntime } from '../helpers/isolated-runtime.js';

const cases = JSON.parse(
  readFileSync('tests/fixtures/provider-vault-alias.synthetic.json', 'utf8'),
) as Array<{
  provider: string;
  referenceEnv: string;
  plaintextEnv: string;
  defaultKey: string;
  customKey: string;
}>;
const roots: string[] = [];
afterEach(() => {
  resetActiveVault();
  roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true }));
});

function encrypted(key: string, value: string) {
  const iv = Buffer.alloc(12, 3);
  const cipher = createCipheriv('aes-256-gcm', Buffer.alloc(32, 2), iv);
  return {
    key,
    encrypted: Buffer.concat([cipher.update(value), cipher.final()]).toString('base64'),
    iv: iv.toString('base64'),
    tag: cipher.getAuthTag().toString('base64'),
  };
}

it.each(cases)('honors $provider aliases, newest entries and explicit-reference failures', (c) => {
  const { root, env } = createIsolatedTestRuntime(process.env, resolve('.'));
  roots.push(root);
  writeFileSync(
    env.MEMPHIS_VAULT_STATE_PATH!,
    JSON.stringify({
      salt: Buffer.alloc(32, 1).toString('base64'),
      masterKey: Buffer.alloc(32, 2).toString('base64'),
    }),
  );
  const defaultEntry = encrypted(c.defaultKey, 'synthetic-default');
  const customEntry = encrypted(c.customKey, 'synthetic-custom');
  const publish = (entries: unknown[]) =>
    writeFileSync(env.MEMPHIS_VAULT_ENTRIES_PATH!, JSON.stringify(entries));
  publish([defaultEntry, customEntry]);
  env[c.plaintextEnv] = 'synthetic-plaintext-shadow';
  env[c.referenceEnv] = c.defaultKey;
  expect(resolveProviderKeyResult(c.provider, env)).toEqual({
    source: 'vault',
    key: 'synthetic-default',
  });
  env[c.referenceEnv] = ` ${c.customKey} `;
  expect(resolveProviderKeyResult(c.provider, env)).toEqual({
    source: 'vault',
    key: 'synthetic-custom',
  });
  const newer = encrypted(c.customKey, 'synthetic-replacement');
  publish([defaultEntry, customEntry, newer]);
  expect(resolveProviderKeyResult(c.provider, env)).toEqual({
    source: 'vault',
    key: 'synthetic-replacement',
  });
  publish([defaultEntry]);
  expect(resolveProviderKeyResult(c.provider, env).source).toBe('conflict');
  delete env[c.plaintextEnv];
  expect(resolveProviderKeyResult(c.provider, env)).toEqual({
    source: 'none',
    reason: 'vault_not_found',
  });
  publish([defaultEntry, customEntry, { ...newer, fingerprint: 'synthetic-invalid-fingerprint' }]);
  expect(resolveProviderKeyResult(c.provider, env)).toEqual({
    source: 'none',
    reason: 'vault_error',
  });
  env[c.plaintextEnv] = 'synthetic-plaintext-shadow';
  expect(resolveProviderKeyResult(c.provider, env)).toMatchObject({
    source: 'conflict',
    vaultError: 'Vault credential could not be read',
  });
  env[c.plaintextEnv] = ' synthetic-plaintext-shadow ';
  env[c.referenceEnv] = '  ';
  expect(resolveProviderKeyResult(c.provider, env)).toEqual({
    source: 'plaintext',
    key: 'synthetic-plaintext-shadow',
  });
});
