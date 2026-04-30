/**
 * Vault path resolution — root-cause fix for the cwd-relative footgun.
 *
 * Before this change, `MEMPHIS_VAULT_STATE_PATH` and
 * `MEMPHIS_VAULT_ENTRIES_PATH` defaulted to './data/...', which meant any
 * process whose cwd was the repo root shared the production daemon's vault
 * paths. The 2026-04-25 silent re-init incident traced back to exactly that.
 *
 * Pin the new contract:
 *   1. Explicit env override wins (smoke tests must always pass tmpdir).
 *   2. Legacy `${installRoot}/data/<file>` is honored with deprecation
 *      warning if the file already exists (backward-compat for operators
 *      who initialized vault before this change).
 *   3. Otherwise the default is absolute `${MEMPHIS_HOME}/<file>` where
 *      MEMPHIS_HOME defaults to ~/.memphis, independent of cwd.
 */

import {
  existsSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
  mkdirSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  __resetVaultPathWarnings,
  resolveVaultPath,
} from '../../src/infra/storage/vault-paths.js';
import { realTmpdir as tmpdir } from '../helpers/tmpdir.js';

interface Sandbox {
  dir: string;
  installRoot: string;
}

function setup(): Sandbox {
  const dir = mkdtempSync(join(tmpdir(), 'memphis-vault-paths-'));
  // Make the sandbox look like a memphis install root so resolveInstallRoot
  // can find it via cwd walk-up.
  const installRoot = dir;
  mkdirSync(join(installRoot, 'data'), { recursive: true });
  writeFileSync(
    join(installRoot, 'package.json'),
    JSON.stringify({ name: '@memphis-chains/memphis' }),
  );
  return { dir, installRoot };
}

function tearDown(sb: Sandbox): void {
  rmSync(sb.dir, { recursive: true, force: true });
}

describe('resolveVaultPath — explicit env override', () => {
  beforeEach(() => __resetVaultPathWarnings());

  it('returns the absolute env value when MEMPHIS_VAULT_STATE_PATH is set', () => {
    const got = resolveVaultPath('vault-state.json', {
      MEMPHIS_VAULT_STATE_PATH: '/tmp/explicit-state.json',
    } as NodeJS.ProcessEnv);
    expect(got).toBe('/tmp/explicit-state.json');
  });

  it('returns the absolute env value when MEMPHIS_VAULT_ENTRIES_PATH is set', () => {
    const got = resolveVaultPath('vault-entries.json', {
      MEMPHIS_VAULT_ENTRIES_PATH: '/tmp/explicit-entries.json',
    } as NodeJS.ProcessEnv);
    expect(got).toBe('/tmp/explicit-entries.json');
  });

  it('resolves a relative env override against current cwd', () => {
    const got = resolveVaultPath('vault-state.json', {
      MEMPHIS_VAULT_STATE_PATH: 'rel/sub.json',
    } as NodeJS.ProcessEnv);
    expect(got).toBe(resolve('rel/sub.json'));
  });
});

describe('resolveVaultPath — legacy compatibility + new default', () => {
  let sb: Sandbox;
  let restoreCwd: () => void;

  beforeEach(() => {
    __resetVaultPathWarnings();
    sb = setup();
    const previousCwd = process.cwd();
    process.chdir(sb.installRoot);
    restoreCwd = () => process.chdir(previousCwd);
  });

  afterEach(() => {
    restoreCwd();
    tearDown(sb);
  });

  it('falls back to the new absolute default when no env and no legacy file', () => {
    const homeOverride = mkdtempSync(join(tmpdir(), 'memphis-home-'));
    try {
      const got = resolveVaultPath('vault-state.json', {
        MEMPHIS_HOME: homeOverride,
        MEMPHIS_DATA_DIR: homeOverride,
      } as NodeJS.ProcessEnv);
      expect(got).toBe(join(homeOverride, 'vault-state.json'));
    } finally {
      rmSync(homeOverride, { recursive: true, force: true });
    }
  });

  it('uses the legacy ${installRoot}/data/<file> when it already exists', () => {
    const legacyState = join(sb.installRoot, 'data', 'vault-state.json');
    writeFileSync(legacyState, '{"salt":"x","encryptedMasterKey":"y"}');

    const got = resolveVaultPath('vault-state.json', {
      MEMPHIS_DATA_DIR: '/var/empty/should-not-be-used',
    } as NodeJS.ProcessEnv);
    expect(got).toBe(legacyState);
  });

  it('does NOT pick up legacy when the file is absent at install root', () => {
    const homeOverride = mkdtempSync(join(tmpdir(), 'memphis-home-'));
    try {
      // Sandbox install root has no data/vault-state.json — confirm we go
      // to the absolute default instead.
      expect(existsSync(join(sb.installRoot, 'data', 'vault-state.json'))).toBe(false);
      const got = resolveVaultPath('vault-state.json', {
        MEMPHIS_DATA_DIR: homeOverride,
      } as NodeJS.ProcessEnv);
      expect(got).toBe(join(homeOverride, 'vault-state.json'));
    } finally {
      rmSync(homeOverride, { recursive: true, force: true });
    }
  });

  it('uses ~/.memphis when MEMPHIS_DATA_DIR is unset', () => {
    const got = resolveVaultPath('vault-state.json', {} as NodeJS.ProcessEnv);
    expect(got).toBe(join(homedir(), '.memphis', 'vault-state.json'));
  });
});
