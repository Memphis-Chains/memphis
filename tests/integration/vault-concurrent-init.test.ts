import { spawn, spawnSync } from 'node:child_process';
import { existsSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { createIsolatedTestRuntime } from '../helpers/isolated-runtime.js';

const roots: string[] = [];
afterEach(() => roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true })));
const script = ['--import', 'tsx', 'tests/helpers/vault-init-process.mts'];

function fixture(journal: string) {
  const fixture = createIsolatedTestRuntime(process.env, resolve('.'));
  roots.push(fixture.root);
  fixture.env.MEMPHIS_VAULT_PEPPER = 'synthetic-init-pepper-for-concurrency';
  if (journal === 'state') {
    delete fixture.env.MEMPHIS_ENV_FILE;
    delete fixture.env.MEMPHIS_RUNTIME_ROOT;
  }
  if (journal === 'root') delete fixture.env.MEMPHIS_ENV_FILE;
  return fixture;
}

async function waitFor(path: string) {
  const deadline = Date.now() + 20000;
  while (!existsSync(path)) {
    expect(Date.now()).toBeLessThan(deadline);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

function launch(env: NodeJS.ProcessEnv, ...args: string[]) {
  const child = spawn(process.execPath, [...script, ...args], {
    env,
    timeout: 30000,
    killSignal: 'SIGKILL',
  });
  let stderr = '';
  child.stdout.resume();
  child.stderr.on('data', (chunk) => {
    stderr += chunk;
  });
  const done = new Promise<{ code: number | null; stderr: string }>((resolve, reject) => {
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, stderr }));
  });
  return { child, done };
}

function run(env: NodeJS.ProcessEnv, mode: string) {
  const result = spawnSync(process.execPath, [...script, mode], {
    env,
    encoding: 'utf8',
    timeout: 30000,
  });
  expect(result.status, result.stderr).toBe(0);
}

describe('concurrent vault initialization', () => {
  it.each(['dotenv', 'state', 'root', 'mixed'])(
    'preserves the first key with the %s journal',
    async (journal) => {
      const { root, env } = fixture(journal);
      const ready = join(root, 'ready');
      const release = join(root, 'release');
      const first = launch(env, 'hold', ready, release);
      const workers = [first];
      try {
        await waitFor(ready);
        const started = join(root, 'second-started');
        const secondEnv = { ...env };
        if (journal === 'mixed') {
          delete secondEnv.MEMPHIS_ENV_FILE;
          delete secondEnv.MEMPHIS_RUNTIME_ROOT;
        }
        const second = launch(secondEnv, 'reject', started);
        workers.push(second);
        await waitFor(started);
        await new Promise((resolve) => setTimeout(resolve, 250));
        expect(second.child.exitCode).toBeNull();
        writeFileSync(release, 'continue');
        for (const result of await Promise.all(workers.map((worker) => worker.done))) {
          expect(result.code, result.stderr).toBe(0);
        }
        run(env, 'read');
      } finally {
        for (const worker of workers)
          if (worker.child.exitCode === null) worker.child.kill('SIGKILL');
        await Promise.all(workers.map((worker) => worker.done));
      }
    },
    90000,
  );

  it('allows a new initializer after SIGKILL before publication', async () => {
    const { root, env } = fixture('dotenv');
    const ready = join(root, 'ready');
    const first = launch(env, 'hold', ready, join(root, 'never-release'));
    try {
      await waitFor(ready);
      expect(existsSync(env.MEMPHIS_VAULT_STATE_PATH!)).toBe(false);
      first.child.kill('SIGKILL');
      await first.done;
      run(env, 'init');
      run(env, 'read');
    } finally {
      if (first.child.exitCode === null) first.child.kill('SIGKILL');
      await first.done;
    }
  }, 90000);
});
