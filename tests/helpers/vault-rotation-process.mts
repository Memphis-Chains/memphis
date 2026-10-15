import assert from 'node:assert/strict';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';

const [mode, operation, point] = process.argv.slice(2);
const oldPepper = 'synthetic-original-pepper-for-crash-test';
const newPepper = 'synthetic-replacement-pepper-for-crash-test';
const secrets = [
  ['first', 'synthetic-first-credential'],
  ['second', 'synthetic-drugie-poświadczenie'],
];

// Exercise the normal startup loader, including recovery before dotenv loading.
await import('../../src/infra/config/env.js');
const { vaultInit, vaultEncrypt, vaultDecrypt, rotateVaultMasterKey } =
  await import('../../src/infra/storage/rust-vault-adapter.js');
const { saveVaultEntry, listVaultEntries, verifyVaultEntry } =
  await import('../../src/infra/storage/vault-entry-store.js');

if (mode === 'init') {
  vaultInit({
    passphrase: 'Synthetic-Strong-Passphrase!123',
    recovery_question: 'fixture?',
    recovery_answer: 'synthetic',
  });
  for (const [key, secret] of secrets) saveVaultEntry(vaultEncrypt(key, secret));
} else if (mode === 'rotate') {
  const { rotateVaultPepperAndConfig } =
    await import('../../src/infra/storage/vault-pepper-transaction.js');
  const targets = [
    process.env.MEMPHIS_VAULT_STATE_PATH,
    operation === 'pepper' ? process.env.MEMPHIS_ENV_FILE : process.env.MEMPHIS_VAULT_ENTRIES_PATH,
  ];
  const rename = fs.renameSync;
  // Test-process-only interception. Kill the real operation at publication;
  // never replace crypto, transaction logic or recovery with a mock.
  fs.renameSync = (source, destination) => {
    const index = targets.indexOf(String(destination));
    if (point === 'prepared' && index === 0) process.kill(process.pid, 'SIGKILL');
    rename(source, destination);
    if (point === String(index)) process.kill(process.pid, 'SIGKILL');
  };
  syncBuiltinESMExports();
  if (operation === 'pepper') rotateVaultPepperAndConfig(oldPepper, newPepper);
  else rotateVaultMasterKey();
  throw new Error('Expected injected SIGKILL was not reached');
} else if (mode === 'read') {
  const entries = listVaultEntries();
  assert.equal(entries.length, secrets.length);
  for (const [key, secret] of secrets) {
    const entry = entries.find((candidate) => candidate.key === key);
    assert.ok(entry);
    assert.equal(verifyVaultEntry(entry), true);
    assert.equal(vaultDecrypt(entry), secret);
  }
  assert.equal(process.env.MEMPHIS_VAULT_PEPPER, operation === 'pepper' ? newPepper : oldPepper);
  const { recoverConfigurationTransaction } =
    await import('../../src/infra/config/config-transaction.js');
  assert.equal(recoverConfigurationTransaction(process.env.MEMPHIS_ENV_FILE!), false);
} else {
  throw new Error('Unknown fixture action');
}
console.log('VAULT_FIXTURE_OK');
// One-shot native processes must not enter the known V8/NAPI teardown race.
process.exit(0);
