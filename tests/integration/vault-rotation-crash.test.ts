import { spawnSync } from 'node:child_process';
import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { createIsolatedTestRuntime } from '../helpers/isolated-runtime.js';

const roots: string[] = [];
afterEach(() => roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true })));

function run(env: NodeJS.ProcessEnv, ...args: string[]) {
  return spawnSync(
    process.execPath,
    ['--import', 'tsx', 'tests/helpers/vault-rotation-process.mts', ...args],
    {
      cwd: resolve('.'),
      env,
      encoding: 'utf8',
      timeout: 30000,
    },
  );
}

describe('native encrypted vault rotation crash recovery', () => {
  for (const operation of ['pepper', 'master-key']) {
    it.each(['prepared', '0', '1'])(
      `${operation}: recovers crash at %s and reads every credential`,
      (point) => {
        const { root, env } = createIsolatedTestRuntime(process.env, resolve('.'));
        roots.push(root);
        const envPath = env.MEMPHIS_ENV_FILE!;
        writeFileSync(envPath, 'MEMPHIS_VAULT_PEPPER=synthetic-original-pepper-for-crash-test\n', {
          mode: 0o600,
        });
        const initial = run(env, 'init');
        expect(initial.status, initial.stderr).toBe(0);
        const originalState = readFileSync(env.MEMPHIS_VAULT_STATE_PATH!);
        const originalEntries = readFileSync(env.MEMPHIS_VAULT_ENTRIES_PATH!);
        const crash = run(env, 'rotate', operation, point);
        expect(crash.signal, crash.stderr).toBe('SIGKILL');
        // Model systemd loading EnvironmentFile before the application recovers.
        const inheritedPepper =
          point === '1' && operation === 'pepper'
            ? 'synthetic-replacement-pepper-for-crash-test'
            : 'synthetic-original-pepper-for-crash-test';
        const recovered = run({ ...env, MEMPHIS_VAULT_PEPPER: inheritedPepper }, 'read', operation);
        expect(recovered.status, recovered.stderr).toBe(0);
        expect(recovered.stdout).toContain('VAULT_FIXTURE_OK');
        expect(readFileSync(env.MEMPHIS_VAULT_STATE_PATH!)).not.toEqual(originalState);
        const entries = readFileSync(env.MEMPHIS_VAULT_ENTRIES_PATH!);
        if (operation === 'pepper') expect(entries).toEqual(originalEntries);
        else expect(entries).not.toEqual(originalEntries);
        // A second, independent startup must read the completed generation too.
        const repeated = run(env, 'read', operation);
        expect(repeated.status, repeated.stderr).toBe(0);
        for (const result of [initial, crash, recovered, repeated]) {
          expect(result.stdout + result.stderr).not.toContain('synthetic-first-credential');
          expect(result.stdout + result.stderr).not.toContain('synthetic-drugie-poświadczenie');
        }
      },
      120000,
    );
  }
});
