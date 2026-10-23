import assert from 'node:assert/strict';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';

import {
  VaultAlreadyInitializedError,
  vaultDecrypt,
  vaultEncrypt,
  vaultInit,
} from '../../src/infra/storage/rust-vault-adapter.js';
import { listVaultEntries, saveVaultEntry } from '../../src/infra/storage/vault-entry-store.js';

const [mode, ready, release] = process.argv.slice(2);
const input = {
  passphrase: 'Synthetic-Init-Passphrase!123',
  recovery_question: 'fixture?',
  recovery_answer: 'synthetic',
};

if (mode === 'hold') {
  const rename = fs.renameSync;
  fs.renameSync = (source, destination) => {
    if (String(destination) === process.env.MEMPHIS_VAULT_STATE_PATH) {
      fs.writeFileSync(ready, 'before-publication');
      const deadline = Date.now() + 25000;
      while (!fs.existsSync(release)) {
        assert.ok(Date.now() < deadline, 'Fixture release deadline exceeded');
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
      }
    }
    rename(source, destination);
  };
  syncBuiltinESMExports();
}

if (mode === 'reject') {
  fs.writeFileSync(ready, 'attempting-init');
  assert.throws(() => vaultInit(input), VaultAlreadyInitializedError);
} else if (mode === 'read') {
  const entries = listVaultEntries();
  assert.equal(entries.length, 1);
  assert.equal(vaultDecrypt(entries[0]), 'synthetic-winning-secret');
} else if (mode === 'hold' || mode === 'init') {
  vaultInit(input);
  saveVaultEntry(vaultEncrypt('winner', 'synthetic-winning-secret'));
} else {
  throw new Error('Unknown fixture action');
}
console.log('VAULT_INIT_FIXTURE_OK');
process.exit(0);
