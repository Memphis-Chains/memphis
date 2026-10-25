import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, isAbsolute, relative, resolve } from 'node:path';

import { parse } from 'dotenv';

assert.equal(process.env.NODE_ENV, 'test');
const root = realpathSync(process.env.MEMPHIS_RUNTIME_ROOT!);
assert.ok(basename(root).startsWith('memphis-vitest-'));
assert.ok(root.startsWith(realpathSync(tmpdir()) + '/'));
function inside(value: string) {
  const path = relative(root, resolve(root, value));
  assert.ok(path && !path.startsWith('..') && !isAbsolute(path), 'fixture path escaped root');
}
inside(process.env.MEMPHIS_ENV_FILE!);
const fileValues = parse(readFileSync(process.env.MEMPHIS_ENV_FILE!, 'utf8'));
for (const values of [fileValues, process.env]) {
  for (const key of [
    'MEMPHIS_DATA_DIR',
    'MEMPHIS_HOME',
    'MEMPHIS_VAULT_STATE_PATH',
    'MEMPHIS_VAULT_ENTRIES_PATH',
    'MEMPHIS_SECURITY_AUDIT_LOG_PATH',
  ]) {
    if (values[key] !== undefined) inside(values[key]!);
  }
  if (values.DATABASE_URL) inside(values.DATABASE_URL.replace(/^file:/, ''));
}
const expectedData = resolve(root, process.env.MEMPHIS_DATA_DIR ?? fileValues.MEMPHIS_DATA_DIR!);
// Guard fixture paths before importing any application module or loading dotenv.
await import('../../src/infra/config/env.js');
const { initializeRuntimeConfigSnapshot, nativeRuntimeEnvironment } =
  await import('../../src/infra/config/runtime-config-snapshot.js');
const { getChainPath } = await import('../../src/config/paths.js');
const chainsDir = getChainPath();
const journalPath = getChainPath('journal');
const snapshot = initializeRuntimeConfigSnapshot();
assert.equal(
  resolve(snapshot.dataDir.path),
  expectedData,
  'data directory must be anchored to runtime root',
);
for (const value of [snapshot.dataDir, snapshot.vaultState, snapshot.vaultEntries]) {
  inside(value.path);
}
const { readVaultSecretByKey } = await import('../../src/security/vault-boundary.js');
const secret = readVaultSecretByKey('first', { surface: 'system' });
const readable = secret.found && secret.plaintext === process.env.MEMPHIS_FIXTURE_EXPECTED;
assert.ok(readable, 'isolated TS credential fixture was not readable');
const native = spawnSync(process.argv[2], [], {
  env: nativeRuntimeEnvironment(snapshot),
  encoding: 'utf8',
  timeout: 30000,
});
assert.equal(native.status, 0, 'isolated native path fixture failed');
const report = { snapshot, chainsDir, journalPath, readable, native: JSON.parse(native.stdout) };
await new Promise<void>((done) => process.stdout.write(JSON.stringify(report), () => done()));
// This fixture checks fresh process inputs, not native finalizer stress behavior.
process.exit(0);
