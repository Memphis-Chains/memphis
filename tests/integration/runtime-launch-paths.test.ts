import { spawnSync } from 'node:child_process';
import { createCipheriv, createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { createIsolatedTestRuntime } from '../helpers/isolated-runtime.js';

const roots: string[] = [];
afterEach(() => roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true })));
const golden = readFileSync('tests/fixtures/vault-state-v2.synthetic.json');
const native = resolve(
  process.env.CARGO_TARGET_DIR ?? 'target',
  'debug/examples/runtime-path-fixture',
);
const helper = resolve('tests/helpers/runtime-path-process.mts');
const loader = resolve('node_modules/tsx/dist/loader.mjs');
const pepper = 'synthetic-state-reader-pepper';

function writeVault(data: string, plaintext: string) {
  mkdirSync(data, { recursive: true, mode: 0o700 });
  writeFileSync(join(data, 'vault-state.json'), golden, { mode: 0o600 });
  const cipher = createCipheriv('aes-256-gcm', Buffer.alloc(32, 2), Buffer.alloc(12, 4));
  const entry = {
    key: 'first',
    id: 'synthetic-launch-identity',
    encrypted: Buffer.concat([cipher.update(plaintext), cipher.final()]).toString('base64'),
    iv: Buffer.alloc(12, 4).toString('base64'),
    tag: cipher.getAuthTag().toString('base64'),
    createdAt: '2026-10-18T00:00:00Z',
  };
  const fingerprint = createHash('sha256')
    .update(JSON.stringify({ key: entry.key, encrypted: entry.encrypted, iv: entry.iv }))
    .digest('hex');
  writeFileSync(join(data, 'vault-entries.json'), JSON.stringify([{ ...entry, fingerprint }]), {
    mode: 0o600,
  });
}

function fixture(mode: 'clean' | 'inherited', override = false) {
  expect(existsSync(native), 'Build the isolated runtime-path-fixture example first').toBe(true);
  const f = createIsolatedTestRuntime(process.env, resolve('.'));
  roots.push(f.root);
  const secret = override ? 'synthetic-overridden-credential' : 'synthetic-first-credential';
  writeVault(join(f.root, 'data'), 'synthetic-first-credential');
  const data = join(f.root, override ? 'explicit-data' : 'data');
  if (override) writeVault(data, secret);
  const launchDirs = ['home', 'Work', 'other-project'].map((name) => join(f.root, 'launch', name));
  for (const dir of launchDirs) {
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, '.env'),
      'MEMPHIS_DATA_DIR=./wrong-data\nMEMPHIS_VAULT_PEPPER=synthetic-wrong-pepper\n',
    );
  }
  writeFileSync(
    f.env.MEMPHIS_ENV_FILE!,
    [
      'MEMPHIS_DATA_DIR=./data',
      'MEMPHIS_VAULT_STATE_PATH=./data/vault-state.json',
      'MEMPHIS_VAULT_ENTRIES_PATH=./data/vault-entries.json',
      'DATABASE_URL=file:./data/memphis.db',
      `MEMPHIS_SECURITY_AUDIT_LOG_PATH=${join(f.root, 'data/audit.jsonl')}`,
      `MEMPHIS_VAULT_PEPPER=${pepper}`,
    ].join('\n') + '\n',
    { mode: 0o600 },
  );
  const env: NodeJS.ProcessEnv =
    mode === 'clean'
      ? Object.fromEntries(
          ['PATH', 'HOME', 'LANG', 'TZ'].flatMap((key) =>
            f.env[key] === undefined ? [] : [[key, f.env[key]]],
          ),
        )
      : { ...f.env };
  for (const key of [
    'MEMPHIS_HOME',
    'MEMPHIS_DATA_DIR',
    'MEMPHIS_VAULT_STATE_PATH',
    'MEMPHIS_VAULT_ENTRIES_PATH',
    'DATABASE_URL',
  ])
    delete env[key];
  Object.assign(env, {
    NODE_ENV: 'test',
    MEMPHIS_RUNTIME_ROOT: f.root,
    MEMPHIS_ENV_FILE: f.env.MEMPHIS_ENV_FILE,
    RUST_CHAIN_ENABLED: 'true',
    RUST_CHAIN_BRIDGE_PATH: f.env.RUST_CHAIN_BRIDGE_PATH,
    MEMPHIS_FIXTURE_EXPECTED: secret,
    MEMPHIS_CONFIG_GENERATION: '999',
  });
  if (mode === 'inherited') env.MEMPHIS_DATA_DIR = './data';
  if (override)
    Object.assign(env, {
      MEMPHIS_DATA_DIR: data,
      MEMPHIS_VAULT_STATE_PATH: join(data, 'vault-state.json'),
      MEMPHIS_VAULT_ENTRIES_PATH: join(data, 'vault-entries.json'),
    });
  const protectedFiles = [
    f.env.MEMPHIS_ENV_FILE!,
    ...['data', ...(override ? ['explicit-data'] : [])].flatMap((name) =>
      ['vault-state.json', 'vault-entries.json'].map((file) => join(f.root, name, file)),
    ),
  ];
  return {
    ...f,
    env,
    data,
    secret,
    launchDirs,
    before: new Map(protectedFiles.map((p) => [p, readFileSync(p)])),
  };
}

function verify(f: ReturnType<typeof fixture>, stdout: string, stderr: string) {
  expect(stdout + stderr).not.toContain(f.secret);
  expect(stdout + stderr).not.toContain(pepper);
  const result = JSON.parse(stdout);
  expect(result.readable).toBe(true);
  const snapshot = result.snapshot;
  expect(snapshot.runtimeRoot).toEqual({ path: f.root, source: 'env-override' });
  expect(snapshot.dotenv).toEqual({ path: f.env.MEMPHIS_ENV_FILE, source: 'env-file' });
  expect(resolve(snapshot.dataDir.path)).toBe(f.data);
  expect(resolve(result.chainsDir)).toBe(join(f.data, 'chains'));
  expect(resolve(result.journalPath)).toBe(join(f.data, 'chains/journal'));
  expect(snapshot.vaultState.path).toBe(join(f.data, 'vault-state.json'));
  expect(snapshot.vaultEntries.path).toBe(join(f.data, 'vault-entries.json'));
  expect(snapshot.generation).toBeGreaterThan(0);
  expect(snapshot.generation).not.toBe(999);
  expect(result.native).toEqual({
    runtimeRoot: f.root,
    runtimeRootSource: 'env-override',
    dotenv: f.env.MEMPHIS_ENV_FILE,
    dataDir: snapshot.dataDir.path,
    vaultState: snapshot.vaultState.path,
    vaultEntries: snapshot.vaultEntries.path,
    generation: snapshot.generation,
    readable: true,
  });
  for (const [path, bytes] of f.before) expect(readFileSync(path)).toEqual(bytes);
  for (const dir of f.launchDirs) expect(readdirSync(dir)).toEqual(['.env']);
}

function launch(f: ReturnType<typeof fixture>, cwd: string) {
  return spawnSync(process.execPath, ['--import', loader, helper, native], {
    cwd,
    env: f.env,
    encoding: 'utf8',
    timeout: 65000,
  });
}

describe('runtime paths across fresh launch contexts', () => {
  for (const mode of ['clean', 'inherited'] as const) {
    it.each([0, 1, 2])(
      `${mode} environment from launch directory %i keeps the same encrypted vault`,
      (index) => {
        const f = fixture(mode);
        const result = launch(f, f.launchDirs[index]);
        expect(result.status, result.stderr).toBe(0);
        verify(f, result.stdout, result.stderr);
      },
      90000,
    );
  }
  it('honors explicit inherited paths over dotenv and preserves them after another start', () => {
    const f = fixture('inherited', true);
    for (const dir of [f.launchDirs[0], f.launchDirs[2]]) {
      const result = launch(f, dir);
      expect(result.status, result.stderr).toBe(0);
      verify(f, result.stdout, result.stderr);
    }
  }, 180000);

  const systemdAvailable =
    process.platform === 'linux' && existsSync(`/run/user/${process.getuid?.()}/bus`);
  it.skipIf(!systemdAvailable)(
    'keeps the same paths from an isolated transient user service with clean env',
    () => {
      const f = fixture('clean');
      const args = [
        '--user',
        '--quiet',
        '--wait',
        '--pipe',
        '--collect',
        `--unit=memphis-v11-fixture-${process.pid}-${Date.now()}`,
        `--property=WorkingDirectory=${f.launchDirs[2]}`,
        '/usr/bin/env',
        '-i',
        ...Object.entries(f.env)
          .filter(([, value]) => value !== undefined)
          .map(([key, value]) => `${key}=${value}`),
        process.execPath,
        '--import',
        loader,
        helper,
        native,
      ];
      const result = spawnSync('systemd-run', args, { encoding: 'utf8', timeout: 90000 });
      expect(result.status, result.stderr).toBe(0);
      verify(f, result.stdout, result.stderr);
    },
    120000,
  );
});
