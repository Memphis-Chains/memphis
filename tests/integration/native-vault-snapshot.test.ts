import { spawn, spawnSync } from 'node:child_process';
import { existsSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { createIsolatedTestRuntime } from '../helpers/isolated-runtime.js';

const roots: string[] = [];
afterEach(() => roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true })));
const script = ['--import', 'tsx', 'tests/helpers/vault-rotation-process.mts'];
const reader = resolve('target/debug/examples/vault-read-fixture');
function fixture() {
  expect(
    existsSync(reader),
    'Build cargo example vault-read-fixture before this integration test',
  ).toBe(true);
  const fixture = createIsolatedTestRuntime(process.env, resolve('.'));
  roots.push(fixture.root);
  fixture.env.MEMPHIS_VAULT_PEPPER = 'synthetic-original-pepper-for-crash-test';
  writeFileSync(
    fixture.env.MEMPHIS_ENV_FILE!,
    `MEMPHIS_VAULT_PEPPER=${fixture.env.MEMPHIS_VAULT_PEPPER}\n`,
  );
  const init = spawnSync(process.execPath, [...script, 'init'], {
    env: fixture.env,
    encoding: 'utf8',
    timeout: 30000,
  });
  expect(init.status, init.stderr).toBe(0);
  return fixture;
}
async function waitFor(path: string) {
  const deadline = Date.now() + 20000;
  while (!existsSync(path)) {
    expect(Date.now()).toBeLessThan(deadline);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}
function launch(command: string, args: string[], env: NodeJS.ProcessEnv) {
  const child = spawn(command, args, { env, timeout: 30000, killSignal: 'SIGKILL' });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk) => {
    stdout += chunk;
  });
  child.stderr.on('data', (chunk) => {
    stderr += chunk;
  });
  const done = new Promise<{ code: number | null; stdout: string; stderr: string }>(
    (resolve, reject) => {
      child.on('error', reject);
      child.on('close', (code) => resolve({ code, stdout, stderr }));
    },
  );
  return { child, done };
}

describe('Rust vault snapshots and TypeScript publication', () => {
  it('waits for both files instead of reading a partly published rotation', async () => {
    const { root, env } = fixture();
    const ready = join(root, 'rotation-ready');
    const release = join(root, 'release');
    const rotating = launch(process.execPath, [...script, 'hold-rotation', ready, release], env);
    const children = [rotating];
    try {
      await waitFor(ready);
      const started = join(root, 'reader-started');
      const reading = launch(reader, [started], env);
      children.push(reading);
      await waitFor(started);
      await new Promise((resolve) => setTimeout(resolve, 250));
      expect(reading.child.exitCode).toBeNull();
      writeFileSync(release, 'continue');
      expect((await rotating.done).code).toBe(0);
      const result = await reading.done;
      expect(result.code, result.stderr).toBe(0);
      expect(result.stdout).toContain('NATIVE_VAULT_OK');
    } finally {
      for (const item of children) if (item.child.exitCode === null) item.child.kill('SIGKILL');
      await Promise.all(children.map((item) => item.done));
    }
  }, 90000);

  it('reports pending recovery without decrypting a mixed generation after a writer crash', () => {
    const { env } = fixture();
    const crash = spawnSync(process.execPath, [...script, 'rotate', 'master-key', '0'], {
      env,
      encoding: 'utf8',
      timeout: 30000,
    });
    expect(crash.signal, crash.stderr).toBe('SIGKILL');
    const blocked = spawnSync(reader, [], { env, encoding: 'utf8', timeout: 15000 });
    expect(blocked.status).toBe(3);
    expect(blocked.stderr).toContain('pending configuration transaction');
    const recovered = spawnSync(process.execPath, [...script, 'read', 'master-key'], {
      env,
      encoding: 'utf8',
      timeout: 30000,
    });
    expect(recovered.status, recovered.stderr).toBe(0);
    const after = spawnSync(reader, [], { env, encoding: 'utf8', timeout: 15000 });
    expect(after.status, after.stderr).toBe(0);
  }, 90000);
});
