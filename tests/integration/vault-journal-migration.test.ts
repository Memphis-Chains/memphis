import { spawnSync } from 'node:child_process';
import { existsSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { createIsolatedTestRuntime } from '../helpers/isolated-runtime.js';

const roots: string[] = [];
afterEach(() => roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true })));
const script = ['--import', 'tsx', 'tests/helpers/vault-rotation-process.mts'];
const reader = resolve(
  process.env.CARGO_TARGET_DIR ?? 'target',
  'debug/examples/vault-read-fixture',
);

function run(env: NodeJS.ProcessEnv, ...args: string[]) {
  return spawnSync(process.execPath, [...script, ...args], {
    env,
    encoding: 'utf8',
    timeout: 30000,
  });
}

describe('vault journal compatibility across TS/native launches', () => {
  it.each(['pepper', 'master-key'])(
    'recovers an encrypted %s rotation from the legacy dotenv journal',
    (operation) => {
      expect(existsSync(reader), 'Build native vault-read-fixture before running this test').toBe(
        true,
      );
      const { root, env } = createIsolatedTestRuntime(process.env, resolve('.'));
      roots.push(root);
      env.MEMPHIS_VAULT_PEPPER = 'synthetic-original-pepper-for-crash-test';
      writeFileSync(env.MEMPHIS_ENV_FILE!, `MEMPHIS_VAULT_PEPPER=${env.MEMPHIS_VAULT_PEPPER}\n`);
      const init = run(env, 'init');
      expect(init.status, init.stderr).toBe(0);
      const crashed = run(env, 'rotate', operation, '0');
      expect(crashed.signal, crashed.stderr).toBe('SIGKILL');

      // Reproduce the historical layout using real encrypted intent after SIGKILL.
      // Only move journals in this disposable fixture; no crypto is mocked.
      const dotenvJournal = `${env.MEMPHIS_ENV_FILE}.transactions`;
      renameSync(dotenvJournal, join(root, 'empty-dotenv-journal'));
      renameSync(`${env.MEMPHIS_VAULT_STATE_PATH}.transactions`, dotenvJournal);
      delete env.MEMPHIS_ENV_FILE; // Both surfaces must select <runtime-root>/.env.
      const pending = spawnSync(reader, [], { env, encoding: 'utf8', timeout: 15000 });
      expect(pending.status, pending.stderr).toBe(3);
      expect(pending.stderr).toContain('pending configuration transaction');

      const recovered = run(env, 'read', operation);
      expect(recovered.status, recovered.stderr).toBe(0);
      if (operation === 'pepper')
        env.MEMPHIS_VAULT_PEPPER = 'synthetic-replacement-pepper-for-crash-test';
      const native = spawnSync(reader, [], { env, encoding: 'utf8', timeout: 15000 });
      expect(native.status, native.stderr).toBe(0);
      expect(native.stdout).toContain('NATIVE_VAULT_OK');
      const repeated = run(env, 'read', operation);
      expect(repeated.status, repeated.stderr).toBe(0);
    },
    90000,
  );
});
