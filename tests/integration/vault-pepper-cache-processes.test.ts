import { spawn, spawnSync } from 'node:child_process';
import { existsSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { expect, it } from 'vitest';

import { createIsolatedTestRuntime } from '../helpers/isolated-runtime.js';

const script = ['--import', 'tsx', 'tests/helpers/vault-rotation-process.mts'];
const reader = resolve(
  process.env.CARGO_TARGET_DIR ?? 'target',
  'debug/examples/vault-read-fixture',
);

function run(env: NodeJS.ProcessEnv, ...args: string[]) {
  return spawnSync(process.execPath, [...script, ...args], {
    env,
    encoding: 'utf8',
    timeout: 60000,
  });
}

function launch(command: string, args: string[], env: NodeJS.ProcessEnv) {
  const child = spawn(command, args, { env, timeout: 90000, killSignal: 'SIGKILL' });
  let stderr = '';
  child.stderr.on('data', (chunk) => {
    stderr += chunk;
  });
  const done = new Promise<{ code: number | null; stderr: string }>((resolve, reject) => {
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, stderr }));
  });
  return { child, done };
}

async function waitFor(path: string) {
  const deadline = Date.now() + 60000;
  while (!existsSync(path)) {
    expect(Date.now(), 'Reader must warm its cache before rotation').toBeLessThan(deadline);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

it('rejects an externally rotated pepper in warm TS/native processes and accepts it after a fresh configuration load', async () => {
  const { root, env } = createIsolatedTestRuntime(process.env, resolve('.'));
  const children: ReturnType<typeof launch>[] = [];
  try {
    env.MEMPHIS_VAULT_PEPPER = 'synthetic-original-pepper-for-crash-test';
    writeFileSync(env.MEMPHIS_ENV_FILE!, `MEMPHIS_VAULT_PEPPER=${env.MEMPHIS_VAULT_PEPPER}\n`);
    const seed = run(env, 'seed');
    expect(seed.status, seed.stderr).toBe(0);
    const tsReady = join(root, 'ts-ready');
    const nativeReady = join(root, 'native-ready');
    const release = join(root, 'release');
    children.push(
      launch(process.execPath, [...script, 'wait-pepper-rotation', tsReady, release], env),
    );
    await waitFor(tsReady);
    children.push(
      launch(reader, [], {
        ...env,
        MEMPHIS_FIXTURE_CACHE_READY: nativeReady,
        MEMPHIS_FIXTURE_CACHE_RELEASE: release,
        MEMPHIS_FIXTURE_CACHE_EXPECT_ERROR: 'VAULT_STATE_AUTH_FAILED',
      }),
    );
    await waitFor(nativeReady);
    const rotation = run(env, 'rotate-pepper-clean');
    expect(rotation.status, rotation.stderr).toBe(0);
    writeFileSync(release, 'continue');
    for (const child of children) {
      const result = await child.done;
      expect(result.code, result.stderr).toBe(0);
    }
    // A fresh configuration load must not inherit an explicit stale override.
    const freshEnv = { ...env };
    delete freshEnv.MEMPHIS_VAULT_PEPPER;
    const fresh = run(freshEnv, 'read', 'pepper');
    expect(fresh.status, fresh.stderr).toBe(0);
    const freshNative = spawnSync(reader, [], {
      env: { ...env, MEMPHIS_VAULT_PEPPER: 'synthetic-replacement-pepper-for-crash-test' },
      encoding: 'utf8',
      timeout: 30000,
    });
    expect(freshNative.status, freshNative.stderr).toBe(0);
    expect(freshNative.stdout).toContain('NATIVE_VAULT_OK');
  } finally {
    for (const child of children) if (child.child.exitCode === null) child.child.kill('SIGKILL');
    await Promise.all(children.map((child) => child.done));
    rmSync(root, { recursive: true, force: true });
  }
}, 180000);
