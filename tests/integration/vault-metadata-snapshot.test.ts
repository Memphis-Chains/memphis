import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  commitConfigurationTransaction,
  configurationFileHash,
  recoverConfigurationTransaction,
} from '../../src/infra/config/config-transaction.js';
import { resetActiveVault, vaultEncrypt } from '../../src/infra/storage/rust-vault-adapter.js';
import {
  getLatestVaultEntry,
  listVaultEntries,
} from '../../src/infra/storage/vault-entry-store.js';
import { resolveVaultJournals } from '../../src/infra/storage/vault-paths.js';
import {
  listVaultEntryMetadata,
  probeVaultStateEntriesIntegrity,
} from '../../src/security/vault-boundary.js';
import { createIsolatedTestRuntime } from '../helpers/isolated-runtime.js';

const roots: string[] = [];
afterEach(() => {
  resetActiveVault();
  roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true }));
});

function pendingPublication() {
  const f = createIsolatedTestRuntime(process.env, resolve('.'));
  roots.push(f.root);
  const statePath = f.env.MEMPHIS_VAULT_STATE_PATH!;
  const entriesPath = f.env.MEMPHIS_VAULT_ENTRIES_PATH!;
  writeFileSync(
    statePath,
    JSON.stringify({
      salt: Buffer.alloc(32, 1).toString('base64'),
      masterKey: Buffer.alloc(32, 2).toString('base64'),
    }),
  );
  writeFileSync(entriesPath, '[]');
  const entries = JSON.stringify([vaultEncrypt('first', 'synthetic-metadata-credential', f.env)]);
  const journals = resolveVaultJournals(f.env).paths;
  expect(() =>
    commitConfigurationTransaction(
      journals,
      [
        {
          path: statePath,
          content: readFileSync(statePath, 'utf8') + '\n',
          expectedHash: configurationFileHash(statePath),
        },
        { path: entriesPath, content: entries, expectedHash: configurationFileHash(entriesPath) },
      ],
      () => {
        throw new Error('synthetic publication interruption');
      },
    ),
  ).toThrow('synthetic publication interruption');
  expect(readFileSync(entriesPath, 'utf8')).toBe('[]');
  return { ...f, journals };
}

describe('metadata reads recover pending vault publication', () => {
  it.each(['list', 'latest', 'metadata', 'boot'])(
    'recovers before the %s absence check',
    (surface) => {
      const { env, journals } = pendingPublication();
      if (surface === 'list') expect(listVaultEntries(env)).toHaveLength(1);
      if (surface === 'latest') expect(getLatestVaultEntry('first', env)?.key).toBe('first');
      if (surface === 'metadata')
        expect(listVaultEntryMetadata({ surface: 'system' }, env)).toMatchObject([
          { key: 'first', integrityOk: true },
        ]);
      if (surface === 'boot')
        expect(probeVaultStateEntriesIntegrity({ surface: 'system' }, env)).toEqual({
          ok: true,
          entriesChecked: 1,
        });
      expect(recoverConfigurationTransaction(journals)).toBe(false);
    },
  );
});
