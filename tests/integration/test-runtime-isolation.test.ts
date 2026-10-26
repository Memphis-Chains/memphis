import { spawnSync } from 'node:child_process';
import {
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { createIsolatedTestRuntime } from '../helpers/isolated-runtime.js';

const roots: string[] = [];
afterEach(() => roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true })));

describe('test runtime isolation', () => {
  it('anchors every fixture path to a canonical temporary root', () => {
    const parent = realpathSync(mkdtempSync(join(tmpdir(), 'memphis-tmp-alias-')));
    roots.push(parent);
    const alias = join(parent, 'alias');
    symlinkSync(parent, alias, 'dir');
    const child = spawnSync(
      process.execPath,
      [
        '--import',
        'tsx',
        '--input-type=module',
        '-e',
        `
      import { createIsolatedTestRuntime } from './tests/helpers/isolated-runtime.ts';
      console.log(JSON.stringify(createIsolatedTestRuntime(process.env, process.cwd())));
    `,
      ],
      {
        env: { ...process.env, TMPDIR: alias, TMP: alias, TEMP: alias },
        encoding: 'utf8',
        timeout: 10000,
      },
    );
    expect(child.status, child.stderr).toBe(0);
    const fixture = JSON.parse(child.stdout);
    expect(fixture.root).toBe(realpathSync(fixture.root));
    expect(fixture.env.HOME).toBe(fixture.root);
    expect(fixture.env.MEMPHIS_ENV_FILE).toBe(join(fixture.root, '.env'));
    expect(fixture.env.MEMPHIS_DATA_DIR).toBe(join(fixture.root, 'data'));
  });

  it('keeps config and vault mutations away from inherited operator paths', () => {
    const operator = mkdtempSync(join(tmpdir(), 'memphis-operator-sentinel-'));
    roots.push(operator);
    const operatorEnv = join(operator, '.env');
    const operatorState = join(operator, 'vault-state.json');
    writeFileSync(operatorEnv, 'MEMPHIS_VAULT_PEPPER=synthetic-operator-pepper\n');
    writeFileSync(operatorState, 'operator-state-sentinel');
    const fixture = createIsolatedTestRuntime(
      {
        ...process.env,
        MEMPHIS_ENV_FILE: operatorEnv,
        MEMPHIS_HOME: operator,
        MEMPHIS_VAULT_STATE_PATH: operatorState,
        MEMPHIS_VAULT_PEPPER: 'synthetic-operator-pepper',
        MEMPHIS_VAULT_FORCE_REINIT: '1',
      },
      resolve('.'),
    );
    roots.push(fixture.root);
    expect(fixture.env.MEMPHIS_VAULT_PEPPER).toBeUndefined();
    expect(fixture.env.MEMPHIS_VAULT_FORCE_REINIT).toBeUndefined();
    const bridge = join(fixture.root, 'bridge.cjs');
    writeFileSync(
      bridge,
      `module.exports = {
      vault_load_state: require(${JSON.stringify(process.env.RUST_CHAIN_BRIDGE_PATH)}).vault_load_state,
      vault_parse_entries: require(${JSON.stringify(process.env.RUST_CHAIN_BRIDGE_PATH)}).vault_parse_entries,
      vault_decode_entry: require(${JSON.stringify(process.env.RUST_CHAIN_BRIDGE_PATH)}).vault_decode_entry,
  vault_init_full: () => ({ vault: { salt: Buffer.alloc(32, 1), master_key: Buffer.alloc(32, 2) }, did: 'did:test', qa_question: 'q' }),
      vault_store: () => {}, vault_retrieve: () => {}
    };`,
    );
    const child = spawnSync(
      process.execPath,
      [
        '--import',
        'tsx',
        '--input-type=module',
        '-e',
        `
      import { setDotEnvValues } from './src/infra/config/dotenv-file.ts';
      import { vaultInit } from './src/infra/storage/rust-vault-adapter.ts';
      setDotEnvValues({ MEMPHIS_VAULT_PEPPER: 'synthetic-fixture-pepper' });
      vaultInit({ passphrase: 'fixture', recovery_question: 'q', recovery_answer: 'a' });
    `,
      ],
      {
        cwd: resolve('.'),
        env: {
          ...fixture.env,
          RUST_CHAIN_BRIDGE_PATH: bridge,
          MEMPHIS_VAULT_PEPPER: 'synthetic-fixture-pepper',
        },
        encoding: 'utf8',
        timeout: 20000,
      },
    );
    expect(child.status, child.stderr).toBe(0);
    expect(readFileSync(operatorEnv, 'utf8')).toBe(
      'MEMPHIS_VAULT_PEPPER=synthetic-operator-pepper\n',
    );
    expect(readFileSync(operatorState, 'utf8')).toBe('operator-state-sentinel');
    expect(readFileSync(fixture.env.MEMPHIS_ENV_FILE!, 'utf8')).toContain(
      'synthetic-fixture-pepper',
    );
    expect(JSON.parse(readFileSync(fixture.env.MEMPHIS_VAULT_STATE_PATH!, 'utf8')).version).toBe(2);
  });
});
