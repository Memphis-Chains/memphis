import { spawn, spawnSync } from 'node:child_process';
import { existsSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { createIsolatedTestRuntime } from '../helpers/isolated-runtime.js';

const roots: string[] = [];
afterEach(() => roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true })));
const command = ['--import', 'tsx', 'tests/helpers/vault-rotation-process.mts'];
function run(env: NodeJS.ProcessEnv, ...args: string[]) {
  const result = spawnSync(process.execPath, [...command, ...args], {
    cwd: resolve('.'),
    env,
    encoding: 'utf8',
    timeout: 30000,
  });
  expect(result.status, result.stderr).toBe(0);
}
function launch(env: NodeJS.ProcessEnv, ...args: string[]) {
  const child = spawn(process.execPath, [...command, ...args], { cwd: resolve('.'), env });
  let stderr = '';
  child.stderr.on('data', (chunk) => {
    stderr += chunk;
  });
  child.stdout.resume();
  const done = new Promise<{ code: number | null; stderr: string }>((resolve, reject) => {
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, stderr }));
  });
  return { child, done };
}
function fixture() {
  const fixture = createIsolatedTestRuntime(process.env, resolve('.'));
  roots.push(fixture.root);
  writeFileSync(
    fixture.env.MEMPHIS_ENV_FILE!,
    'MEMPHIS_VAULT_PEPPER=synthetic-original-pepper-for-crash-test\n',
  );
  run(fixture.env, 'init');
  return fixture;
}

describe('vault writers and rotation', () => {
  it('rejects an entry encrypted before another process rotates and allows a fresh retry', async () => {
    const { root, env } = fixture();
    const ready = join(root, 'ready');
    const release = join(root, 'release');
    const writer = launch(env, 'hold-entry', ready, release);
    try {
      const deadline = Date.now() + 20000;
      while (!existsSync(ready)) {
        expect(Date.now()).toBeLessThan(deadline);
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      run(env, 'rotate-clean');
      writeFileSync(release, 'continue');
      const result = await writer.done;
      expect(result.code, result.stderr).toBe(0);
      run(env, 'read-many', '3');
    } finally {
      if (writer.child.exitCode === null) writer.child.kill('SIGKILL');
      await writer.done;
    }
  }, 90000);

  it('preserves every successful append from concurrent native-encrypted writers', async () => {
    const { env } = fixture();
    const workers = [0, 1, 2].map((id) => launch(env, 'write-many', String(id)));
    try {
      for (const result of await Promise.all(workers.map((worker) => worker.done))) {
        expect(result.code, result.stderr).toBe(0);
      }
      run(env, 'read-many', '14');
    } finally {
      for (const worker of workers)
        if (worker.child.exitCode === null) worker.child.kill('SIGKILL');
      await Promise.all(workers.map((worker) => worker.done));
    }
  }, 90000);
});
