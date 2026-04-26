/**
 * Regression: --pepper-restore must write to ${installRoot}/.env, not
 * ${memphisRoot}/.env. The original implementation
 * (`applyRestoredVaultPepper`) targeted memphisRoot — i.e. ~/.memphis/.env —
 * but the daemon's dotenv loader anchors on installRoot/.env (the repo dir,
 * e.g. ~/memphis/.env). Result: the pepper landed in a file the daemon
 * never reads, and vault decryption silently failed after every
 * cross-host restore. Fix replaces the hardcoded path with
 * `resolveDotEnvPath()` (the same helper `setDotEnvValues` uses).
 *
 * This test pins the fix by:
 *   - building a synthetic install root in a tmpdir (with a `package.json`
 *     so `resolveInstallRoot` accepts the override)
 *   - pointing MEMPHIS_RUNTIME_ROOT at that tmpdir
 *   - running create→restore with --pepper-restore
 *   - asserting the new `MEMPHIS_VAULT_PEPPER=` line landed in the install
 *     root's `.env`, NOT in memphisRoot/.env
 */

import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createBackup, restoreBackup } from '../../src/infra/cli/commands/backup.js';

interface PathDrillEnv {
  memphisRoot: string;
  backupRoot: string;
  installRoot: string;
  originalEnv: NodeJS.ProcessEnv;
}

function setup(): PathDrillEnv {
  const memphisRoot = mkdtempSync(join(tmpdir(), 'memphis-pepperpath-data-'));
  const backupRoot = join(memphisRoot, 'backups');
  mkdirSync(backupRoot, { recursive: true });

  const installRoot = mkdtempSync(join(tmpdir(), 'memphis-pepperpath-install-'));
  // resolveInstallRoot validates MEMPHIS_RUNTIME_ROOT against package.json
  // name "@memphis-chains/memphis"; fake one so the override is accepted.
  writeFileSync(
    join(installRoot, 'package.json'),
    JSON.stringify({ name: '@memphis-chains/memphis' }),
  );

  // Seed a fixture file in memphisRoot so backup has content to capture.
  mkdirSync(join(memphisRoot, 'fixture'), { recursive: true });
  writeFileSync(join(memphisRoot, 'fixture', 'sentinel.txt'), 'untouched', 'utf8');

  const originalEnv = { ...process.env };
  process.env.MEMPHIS_RUNTIME_ROOT = installRoot;
  // Make sure no MEMPHIS_ENV_FILE override leaks in from the parent process.
  delete process.env.MEMPHIS_ENV_FILE;
  return { memphisRoot, backupRoot, installRoot, originalEnv };
}

function tearDown(env: PathDrillEnv): void {
  rmSync(env.memphisRoot, { recursive: true, force: true });
  rmSync(env.installRoot, { recursive: true, force: true });
  process.env = env.originalEnv;
}

describe('--pepper-restore writes to installRoot/.env (not memphisRoot/.env)', () => {
  let env: PathDrillEnv;

  beforeEach(() => {
    env = setup();
  });

  afterEach(() => {
    tearDown(env);
  });

  it('lands the pepper line in the install-root dotenv that the daemon actually reads', async () => {
    const pepperValue = 'restoredPepper2026';
    const created = await createBackup({
      memphisRoot: env.memphisRoot,
      backupRoot: env.backupRoot,
      tag: 'pepperpath',
      showProgress: false,
    });

    // Pre-restore: install-root has no .env yet (no daemon was ever run).
    const installEnvPath = join(env.installRoot, '.env');
    const memphisEnvPath = join(env.memphisRoot, '.env');
    expect(existsSync(installEnvPath)).toBe(false);

    await restoreBackup({
      file: created.file,
      memphisRoot: env.memphisRoot,
      backupRoot: env.backupRoot,
      confirm: true,
      showProgress: false,
      pepperRestore: pepperValue,
    });

    // The pepper line MUST land at installRoot/.env — that's the path the
    // daemon's dotenv loader reads. Anything else is the bug we're guarding.
    expect(existsSync(installEnvPath)).toBe(true);
    expect(readFileSync(installEnvPath, 'utf8')).toContain(`MEMPHIS_VAULT_PEPPER=${pepperValue}`);

    // memphisRoot/.env may or may not exist depending on whether the
    // archive contained a .env (this fixture didn't seed one), but if it
    // does exist, it MUST NOT contain the new pepper — that path is dead.
    if (existsSync(memphisEnvPath)) {
      expect(readFileSync(memphisEnvPath, 'utf8')).not.toContain(
        `MEMPHIS_VAULT_PEPPER=${pepperValue}`,
      );
    }
  });
});
