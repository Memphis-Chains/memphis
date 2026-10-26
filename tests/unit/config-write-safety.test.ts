import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { setDotEnvValues, unsetDotEnvValues } from '../../src/infra/config/dotenv-file.js';

const roots: string[] = [];
afterEach(() => roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true })));
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'config-write-safety-'));
  roots.push(root);
  return {
    MEMPHIS_ENV_FILE: join(root, '.env'),
    MEMPHIS_VAULT_STATE_PATH: join(root, 'vault-state.json'),
  };
}

describe('generic configuration persistence', () => {
  it('blocks both replacement and unset for initialized vaults without changing disk', () => {
    const env = fixture();
    writeFileSync(env.MEMPHIS_ENV_FILE, 'MEMPHIS_VAULT_PEPPER=synthetic-original\n');
    writeFileSync(env.MEMPHIS_VAULT_STATE_PATH, '{}');
    expect(() => setDotEnvValues({ MEMPHIS_VAULT_PEPPER: 'replacement' }, env)).toThrow(
      /pepper-rotate/,
    );
    expect(() => unsetDotEnvValues(['MEMPHIS_VAULT_PEPPER'], env)).toThrow(/pepper-rotate/);
    expect(readFileSync(env.MEMPHIS_ENV_FILE, 'utf8')).toBe(
      'MEMPHIS_VAULT_PEPPER=synthetic-original\n',
    );
  });
  it('serializes initial pepper setup with both the vault-state and dotenv journals', () => {
    const env = fixture();
    setDotEnvValues({ MEMPHIS_VAULT_PEPPER: 'synthetic-initial-pepper' }, env);
    expect(existsSync(`${env.MEMPHIS_VAULT_STATE_PATH}.transactions/journal.sqlite`)).toBe(true);
    expect(existsSync(`${env.MEMPHIS_ENV_FILE}.transactions/journal.sqlite`)).toBe(true);
    expect(readFileSync(env.MEMPHIS_ENV_FILE, 'utf8')).toBe(
      'MEMPHIS_VAULT_PEPPER=synthetic-initial-pepper\n',
    );
  });
  it('creates and replaces configuration privately', () => {
    const env = fixture();
    setDotEnvValues({ EXAMPLE: 'one' }, env);
    expect(statSync(env.MEMPHIS_ENV_FILE).mode & 0o777).toBe(0o600);
    setDotEnvValues({ EXAMPLE: 'two' }, env);
    expect(readFileSync(env.MEMPHIS_ENV_FILE, 'utf8')).toBe('EXAMPLE=two\n');
    unsetDotEnvValues(['EXAMPLE'], env);
    expect(readFileSync(env.MEMPHIS_ENV_FILE, 'utf8')).not.toContain('EXAMPLE');
  });
});
