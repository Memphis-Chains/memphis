import { createCipheriv, createHash } from 'node:crypto';
import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  applyReloadPlan,
  computeReloadPlan,
  performHotReloadSync,
} from '../../src/infra/config/hot-reload.js';
import {
  initializeRuntimeConfigSnapshot,
  resetRuntimeConfigSnapshotForTests,
} from '../../src/infra/config/runtime-config-snapshot.js';
import { resetActiveVault } from '../../src/infra/storage/rust-vault-adapter.js';
import { readLatestVaultSecret } from '../../src/infra/storage/vault-entry-store.js';
import { createIsolatedTestRuntime } from '../helpers/isolated-runtime.js';

const bridge = createRequire(import.meta.url)(process.env.RUST_CHAIN_BRIDGE_PATH!);
const roots: string[] = [];
afterEach(() => {
  resetActiveVault();
  resetRuntimeConfigSnapshotForTests();
  vi.restoreAllMocks();
  roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true }));
});

function fixture() {
  const f = createIsolatedTestRuntime(process.env, resolve('.'));
  roots.push(f.root);
  // The v1 fixture exercises native key ownership without repeatedly running
  // scrypt. Encrypted v2 rotations have separate process acceptance tests.
  writeFileSync(
    f.env.MEMPHIS_VAULT_STATE_PATH!,
    JSON.stringify({
      salt: Buffer.alloc(32, 1).toString('base64'),
      masterKey: Buffer.alloc(32, 2).toString('base64'),
    }),
  );
  replaceEntry(f.env, 'synthetic-first');
  return f;
}

function replaceEntry(env: NodeJS.ProcessEnv, plaintext: string) {
  const iv = Buffer.alloc(12, 3);
  const cipher = createCipheriv('aes-256-gcm', Buffer.alloc(32, 2), iv);
  const entry = {
    key: 'first',
    encrypted: Buffer.concat([cipher.update(plaintext), cipher.final()]).toString('base64'),
    iv: iv.toString('base64'),
  };
  writeFileSync(
    env.MEMPHIS_VAULT_ENTRIES_PATH!,
    JSON.stringify([
      {
        ...entry,
        tag: cipher.getAuthTag().toString('base64'),
        fingerprint: createHash('sha256').update(JSON.stringify(entry)).digest('hex'),
      },
    ]),
  );
}

function read(env: NodeJS.ProcessEnv) {
  return readLatestVaultSecret('first', env)?.plaintext;
}

describe('vault derivation cache lifecycle', () => {
  it('clears a key immediately after an accepted reload, but retains it for no-op, dry-run and rejected changes', () => {
    const { env } = fixture();
    const previous = process.env;
    process.env = { ...env, GEN_MAX_TOKENS: '1024' };
    try {
      initializeRuntimeConfigSnapshot();
      const load = vi.spyOn(bridge, 'vault_load_state');
      expect(read(process.env)).toBe('synthetic-first');
      const key: Buffer = load.mock.results[0].value.vault.master_key;
      const generation = process.env.MEMPHIS_CONFIG_GENERATION;
      for (const content of ['GEN_MAX_TOKENS=1024\n', 'GEN_MAX_TOKENS=99999999\n', 'PORT=4567\n']) {
        writeFileSync(env.MEMPHIS_ENV_FILE!, content);
        performHotReloadSync();
        expect(process.env.MEMPHIS_CONFIG_GENERATION).toBe(generation);
        expect(read(process.env)).toBe('synthetic-first');
        expect(load).toHaveBeenCalledTimes(1);
      }
      writeFileSync(env.MEMPHIS_ENV_FILE!, 'GEN_MAX_TOKENS=2048\n');
      applyReloadPlan(computeReloadPlan(), { dryRun: true });
      expect(key.equals(Buffer.alloc(32))).toBe(false);
      expect(process.env.MEMPHIS_CONFIG_GENERATION).toBe(generation);
      expect(performHotReloadSync().ok).toBe(true);
      expect(key.equals(Buffer.alloc(32))).toBe(true);
      expect(Number(process.env.MEMPHIS_CONFIG_GENERATION)).toBe(Number(generation) + 1);
      expect(read(process.env)).toBe('synthetic-first');
      expect(load).toHaveBeenCalledTimes(2);
    } finally {
      process.env = previous;
    }
  });

  it('reuses an unchanged key while entry replacement and removal are immediately visible', () => {
    const { env } = fixture();
    const load = vi.spyOn(bridge, 'vault_load_state');
    expect(read(env)).toBe('synthetic-first');
    expect(read(env)).toBe('synthetic-first');
    replaceEntry(env, 'synthetic-second');
    expect(read(env)).toBe('synthetic-second');
    writeFileSync(env.MEMPHIS_VAULT_ENTRIES_PATH!, '[]');
    expect(read(env)).toBeUndefined();
    expect(load).toHaveBeenCalledTimes(1);
  });

  it('invalidates and clears the previous key on an accepted configuration generation', () => {
    const { env } = fixture();
    const load = vi.spyOn(bridge, 'vault_load_state');
    env.MEMPHIS_CONFIG_GENERATION = '1';
    expect(read(env)).toBe('synthetic-first');
    const oldKey: Buffer = load.mock.results[0].value.vault.master_key;
    expect(oldKey.equals(Buffer.alloc(32))).toBe(false);
    env.MEMPHIS_CONFIG_GENERATION = '2';
    expect(read(env)).toBe('synthetic-first');
    expect(load).toHaveBeenCalledTimes(2);
    expect(oldKey.equals(Buffer.alloc(32))).toBe(true);
    expect(read(env)).toBe('synthetic-first');
    expect(load).toHaveBeenCalledTimes(2);
  });

  it.each(['missing', 'malformed'])(
    'evicts a warm key on %s state, including failed reloads',
    (kind) => {
      const { env } = fixture();
      const load = vi.spyOn(bridge, 'vault_load_state');
      const statePath = env.MEMPHIS_VAULT_STATE_PATH!;
      const state = readFileSync(statePath);
      expect(read(env)).toBe('synthetic-first');
      const oldKey: Buffer = load.mock.results[0].value.vault.master_key;
      if (kind === 'missing') rmSync(statePath);
      else writeFileSync(statePath, '{synthetic-invalid-state');
      expect(() => read(env)).toThrow(
        kind === 'missing' ? 'VAULT_STATE_MISSING' : 'VAULT_STATE_MALFORMED',
      );
      expect(oldKey.equals(Buffer.alloc(32))).toBe(true);
      const callsAfterFailure = load.mock.calls.length;
      writeFileSync(statePath, state);
      expect(read(env)).toBe('synthetic-first');
      expect(load.mock.calls.length).toBe(callsAfterFailure + 1);
    },
  );

  it('clears the cached key on explicit invalidation', () => {
    const { env } = fixture();
    const load = vi.spyOn(bridge, 'vault_load_state');
    expect(read(env)).toBe('synthetic-first');
    const oldKey: Buffer = load.mock.results[0].value.vault.master_key;
    resetActiveVault();
    expect(oldKey.equals(Buffer.alloc(32))).toBe(true);
    expect(read(env)).toBe('synthetic-first');
    expect(load).toHaveBeenCalledTimes(2);
  });
});
