import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createBackup, restoreBackup } from '../../src/infra/cli/commands/backup.js';

/**
 * Regression net for Codex P1 against PR #86: --pepper-restore validation
 * lived inside applyRestoredVaultPepper, which only ran AFTER the
 * destructive swap. So `--pepper-restore short` would still mutate the
 * data dir before throwing — breaking the "thrown restore = no change"
 * expectation. The fix moves the length check to the top of restoreBackup.
 */

interface DrillEnv {
  memphisRoot: string;
  backupRoot: string;
}

function setup(): DrillEnv {
  const memphisRoot = mkdtempSync(join(tmpdir(), 'memphis-restore-validate-'));
  const backupRoot = join(memphisRoot, 'backups');
  mkdirSync(join(memphisRoot, 'fixture'), { recursive: true });
  writeFileSync(join(memphisRoot, 'fixture', 'sentinel.txt'), 'untouched', 'utf8');
  writeFileSync(join(memphisRoot, '.env'), 'MEMPHIS_VAULT_PEPPER=originalPepper123\n', 'utf8');
  mkdirSync(backupRoot, { recursive: true });
  return { memphisRoot, backupRoot };
}

function tearDown(env: DrillEnv): void {
  rmSync(env.memphisRoot, { recursive: true, force: true });
}

describe('restoreBackup — --pepper-restore validates BEFORE destructive swap', () => {
  let env: DrillEnv;

  beforeEach(() => {
    env = setup();
  });

  afterEach(() => {
    tearDown(env);
  });

  it('rejects short pepper without touching ~/.memphis state', async () => {
    const created = await createBackup({
      memphisRoot: env.memphisRoot,
      backupRoot: env.backupRoot,
      tag: 'pepper-validate',
      showProgress: false,
    });
    // Sentinel exists before restore.
    expect(existsSync(join(env.memphisRoot, 'fixture', 'sentinel.txt'))).toBe(true);
    const beforeBackups = readdirSync(env.backupRoot).length;

    await expect(
      restoreBackup({
        file: created.file,
        memphisRoot: env.memphisRoot,
        backupRoot: env.backupRoot,
        confirm: true,
        showProgress: false,
        pepperRestore: 'short',
      }),
    ).rejects.toThrow(/at least 12 characters/);

    // Critical: no pre-restore safety backup, no swap. Sentinel still in
    // its original spot, .env unchanged, no new backup file created.
    expect(existsSync(join(env.memphisRoot, 'fixture', 'sentinel.txt'))).toBe(true);
    const afterBackups = readdirSync(env.backupRoot).length;
    expect(afterBackups).toBe(beforeBackups);
  });

  it('valid pepper still works (regression check)', async () => {
    const created = await createBackup({
      memphisRoot: env.memphisRoot,
      backupRoot: env.backupRoot,
      tag: 'happy-path',
      showProgress: false,
    });
    const result = await restoreBackup({
      file: created.file,
      memphisRoot: env.memphisRoot,
      backupRoot: env.backupRoot,
      confirm: true,
      showProgress: false,
      pepperRestore: 'sufficientlyLongPepper999',
    });
    expect(result.ok).toBe(true);
  });
});
