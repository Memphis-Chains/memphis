import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import { resolveVaultJournals } from '../../src/infra/storage/vault-paths.js';

const state = resolve('/tmp/synthetic-vault-state.json');
describe('vault journal selection', () => {
  it('keeps state primary and uses the explicit dotenv instead of the runtime root', () => {
    expect(
      resolveVaultJournals({
        MEMPHIS_VAULT_STATE_PATH: state,
        MEMPHIS_ENV_FILE: '  /tmp/explicit.env  ',
        MEMPHIS_RUNTIME_ROOT: '/tmp/other-root',
      }),
    ).toEqual({
      paths: [state, '/tmp/explicit.env'],
      dotenvPath: '/tmp/explicit.env',
      dotenvSource: 'explicit',
    });
  });
  it('uses the runtime root when the explicit dotenv is blank', () => {
    expect(
      resolveVaultJournals({
        MEMPHIS_VAULT_STATE_PATH: state,
        MEMPHIS_ENV_FILE: ' ',
        MEMPHIS_RUNTIME_ROOT: ' /tmp/runtime ',
      }),
    ).toEqual({
      paths: [state, '/tmp/runtime/.env'],
      dotenvPath: '/tmp/runtime/.env',
      dotenvSource: 'runtime-root',
    });
  });
  it('does not guess a cwd dotenv for standalone env-only callers', () => {
    expect(resolveVaultJournals({ MEMPHIS_VAULT_STATE_PATH: state })).toEqual({
      paths: [state],
      dotenvPath: null,
      dotenvSource: 'none',
    });
  });
  it('resolves relative dotenv and runtime paths against cwd', () => {
    expect(
      resolveVaultJournals({ MEMPHIS_VAULT_STATE_PATH: state, MEMPHIS_ENV_FILE: './synthetic.env' })
        .paths,
    ).toEqual([state, resolve('synthetic.env')]);
    expect(
      resolveVaultJournals({
        MEMPHIS_VAULT_STATE_PATH: state,
        MEMPHIS_RUNTIME_ROOT: './synthetic-root',
      }).paths,
    ).toEqual([state, resolve('synthetic-root/.env')]);
  });
});
