import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire, syncBuiltinESMExports } from 'node:module';

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
} else if (mode === 'hold-entry' || mode === 'hold-state-load') {
  if (mode === 'hold-state-load') {
    const bridge = createRequire(import.meta.url)(process.env.RUST_CHAIN_BRIDGE_PATH!);
    const load = bridge.vault_load_state;
    bridge.vault_load_state = (...args: unknown[]) => {
      const loaded = load(...args);
      bridge.vault_load_state = load;
      fs.writeFileSync(operation, 'decoded-state');
      const deadline = Date.now() + 25000;
      while (!fs.existsSync(point)) {
        assert.ok(Date.now() < deadline, 'Fixture state-load release deadline exceeded');
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
      }
      return loaded;
    };
  }
  const entry = vaultEncrypt('racer', 'synthetic-racer');
  if (mode === 'hold-state-load') {
    // Rotation happened while the decoded old key was paused. The adapter must
    // retry its snapshot and encrypt with the new key before returning.
    const stored = saveVaultEntry(entry);
    assert.equal(vaultDecrypt(stored), 'synthetic-racer');
    console.log('VAULT_FIXTURE_OK');
    process.exit(0);
  }
  if (mode === 'hold-entry') fs.writeFileSync(operation, 'ready');
  const deadline = Date.now() + 25000;
  while (!fs.existsSync(point)) {
    assert.ok(Date.now() < deadline, 'Fixture release deadline exceeded');
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  const before = fs.readFileSync(process.env.MEMPHIS_VAULT_ENTRIES_PATH!);
  assert.throws(() => saveVaultEntry(entry), /current vault/);
  assert.deepEqual(fs.readFileSync(process.env.MEMPHIS_VAULT_ENTRIES_PATH!), before);
  // Retry the entire write, not the stale encrypted payload. This also checks
  // that the original process invalidates its cached pre-rotation key.
  const fresh = saveVaultEntry(vaultEncrypt('racer', 'synthetic-racer'));
  assert.equal(vaultDecrypt(fresh), 'synthetic-racer');
} else if (mode === 'rotate-clean') {
  rotateVaultMasterKey();
} else if (mode === 'hold-rotation') {
  const rename = fs.renameSync;
  fs.renameSync = (source, destination) => {
    rename(source, destination);
    if (String(destination) === process.env.MEMPHIS_VAULT_STATE_PATH) {
      fs.writeFileSync(operation, 'published-state');
      const deadline = Date.now() + 25000;
      while (!fs.existsSync(point)) {
        assert.ok(Date.now() < deadline, 'Fixture rotation release deadline exceeded');
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
      }
    }
  };
  syncBuiltinESMExports();
  rotateVaultMasterKey();
} else if (mode === 'write-many') {
  for (let i = 0; i < 4; i++) {
    const key = `writer-${operation}-${i}`;
    saveVaultEntry(vaultEncrypt(key, `synthetic-${key}`));
  }
} else if (mode === 'read-many') {
  const entries = listVaultEntries();
  assert.equal(entries.length, Number(operation));
  assert.equal(new Set(entries.map((entry) => entry.key)).size, entries.length);
  for (const entry of entries) {
    const secret =
      secrets.find(([key]) => key === entry.key)?.[1] ??
      (entry.key === 'racer' ? 'synthetic-racer' : `synthetic-${entry.key}`);
    assert.equal(vaultDecrypt(entry), secret);
  }
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
