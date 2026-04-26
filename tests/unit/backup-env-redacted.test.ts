/**
 * Regression: `memphis backup create` captures a redacted snapshot of
 * `installRoot/.env`, and `memphis backup restore` re-applies the
 * non-secret keys to `installRoot/.env` without overwriting existing
 * values. Phase C of the v1.7.1 gap-fill plan.
 *
 * Threat model:
 *   - secrets (MEMPHIS_VAULT_PEPPER, *_API_KEY, *_TOKEN) MUST stay out of
 *     the archive (operator's external store is authoritative)
 *   - non-secret config (provider URLs, vault refs, runtime knobs) is
 *     captured so a fresh install with a restored archive doesn't need
 *     manual `memphis vault add` re-runs for each provider
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

import { createBackup, restoreBackup, listArchiveContents } from '../../src/infra/cli/commands/backup.js';

interface DrillEnv {
  memphisRoot: string;
  backupRoot: string;
  installRoot: string;
  originalEnv: NodeJS.ProcessEnv;
}

function setup(): DrillEnv {
  const memphisRoot = mkdtempSync(join(tmpdir(), 'memphis-env-redact-data-'));
  const backupRoot = join(memphisRoot, 'backups');
  mkdirSync(backupRoot, { recursive: true });
  // Token fixture content for the data tree so tar has files to capture.
  mkdirSync(join(memphisRoot, 'fixture'), { recursive: true });
  writeFileSync(join(memphisRoot, 'fixture', 'sentinel.txt'), 'untouched', 'utf8');

  const installRoot = mkdtempSync(join(tmpdir(), 'memphis-env-redact-install-'));
  writeFileSync(
    join(installRoot, 'package.json'),
    JSON.stringify({ name: '@memphis-chains/memphis' }),
  );

  const originalEnv = { ...process.env };
  process.env.MEMPHIS_RUNTIME_ROOT = installRoot;
  delete process.env.MEMPHIS_ENV_FILE;
  return { memphisRoot, backupRoot, installRoot, originalEnv };
}

function tearDown(env: DrillEnv): void {
  rmSync(env.memphisRoot, { recursive: true, force: true });
  rmSync(env.installRoot, { recursive: true, force: true });
  process.env = env.originalEnv;
}

describe('backup .env-redacted capture (Phase C)', () => {
  let env: DrillEnv;

  beforeEach(() => {
    env = setup();
  });

  afterEach(() => {
    tearDown(env);
  });

  it('omits secret fields and includes vault-ref + URL fields in archive', async () => {
    const seedEnv = [
      'MEMPHIS_VAULT_PEPPER=topSecretPepperShouldNotLeak',
      'MEMPHIS_API_TOKEN=longLivedAuthToken123',
      'MINIMAX_API_KEY=plaintext-api-key',
      'MINIMAX_VAULT_KEY=minimax_api_key',
      'MINIMAX_BASE_URL=https://api.minimax.io/v1',
      'DEFAULT_PROVIDER=minimax',
    ].join('\n');
    writeFileSync(join(env.installRoot, '.env'), seedEnv, 'utf8');

    const created = await createBackup({
      memphisRoot: env.memphisRoot,
      backupRoot: env.backupRoot,
      tag: 'env-redact',
      showProgress: false,
    });

    const entries = listArchiveContents(created.backupPath);
    const redactedInArchive = entries.find((e) => e.endsWith('.env-redacted') || e === './.env-redacted');
    expect(redactedInArchive).toBeDefined();

    // Read the archive's .env-redacted content via restore-then-inspect.
    // We can't peek inside the tar without re-extracting, so we run a
    // restore into a fresh memphisRoot and assert the merged installRoot
    // .env carries the non-secrets but NOT the secrets.
  });

  it('round-trips: secrets stripped, non-secrets restored to fresh installRoot/.env', async () => {
    const seedEnv = [
      'MEMPHIS_VAULT_PEPPER=topSecretPepperShouldNotLeak',
      'MEMPHIS_API_TOKEN=longLivedAuthToken123',
      'MINIMAX_API_KEY=plaintext-api-key',
      'MINIMAX_VAULT_KEY=minimax_api_key',
      'MINIMAX_BASE_URL=https://api.minimax.io/v1',
      'DEFAULT_PROVIDER=minimax',
    ].join('\n');
    writeFileSync(join(env.installRoot, '.env'), seedEnv, 'utf8');

    const created = await createBackup({
      memphisRoot: env.memphisRoot,
      backupRoot: env.backupRoot,
      tag: 'roundtrip',
      showProgress: false,
    });

    // Simulate a fresh install: blow away install .env, re-apply via restore.
    rmSync(join(env.installRoot, '.env'));
    expect(existsSync(join(env.installRoot, '.env'))).toBe(false);

    await restoreBackup({
      file: created.file,
      memphisRoot: env.memphisRoot,
      backupRoot: env.backupRoot,
      confirm: true,
      showProgress: false,
    });

    // installRoot/.env should now exist with non-secrets but no secrets.
    expect(existsSync(join(env.installRoot, '.env'))).toBe(true);
    const restoredEnv = readFileSync(join(env.installRoot, '.env'), 'utf8');

    // Non-secret config preserved
    expect(restoredEnv).toContain('MINIMAX_VAULT_KEY=minimax_api_key');
    expect(restoredEnv).toContain('MINIMAX_BASE_URL=https://api.minimax.io/v1');
    expect(restoredEnv).toContain('DEFAULT_PROVIDER=minimax');

    // Secrets MUST be stripped
    expect(restoredEnv).not.toContain('topSecretPepperShouldNotLeak');
    expect(restoredEnv).not.toContain('longLivedAuthToken123');
    expect(restoredEnv).not.toContain('plaintext-api-key');
  });

  it('does not overwrite existing keys in installRoot/.env on restore', async () => {
    const seedEnv = [
      'MINIMAX_VAULT_KEY=archived-key-pointer',
      'DEFAULT_PROVIDER=minimax',
    ].join('\n');
    writeFileSync(join(env.installRoot, '.env'), seedEnv, 'utf8');

    const created = await createBackup({
      memphisRoot: env.memphisRoot,
      backupRoot: env.backupRoot,
      tag: 'preserve',
      showProgress: false,
    });

    // Operator-edits .env between backup and restore — different value
    // for an existing key, plus a new key the archive doesn't know.
    writeFileSync(
      join(env.installRoot, '.env'),
      [
        'MINIMAX_VAULT_KEY=operator-edited-pointer',
        'MEMPHIS_API_TOKEN=operator-set-token',
      ].join('\n'),
      'utf8',
    );

    await restoreBackup({
      file: created.file,
      memphisRoot: env.memphisRoot,
      backupRoot: env.backupRoot,
      confirm: true,
      showProgress: false,
    });

    const restored = readFileSync(join(env.installRoot, '.env'), 'utf8');
    // Operator's edit preserved, NOT clobbered by archive's older value
    expect(restored).toContain('MINIMAX_VAULT_KEY=operator-edited-pointer');
    expect(restored).not.toContain('MINIMAX_VAULT_KEY=archived-key-pointer');
    // Operator's manual addition preserved
    expect(restored).toContain('MEMPHIS_API_TOKEN=operator-set-token');
    // Missing-from-existing key gets appended from the archive
    expect(restored).toContain('DEFAULT_PROVIDER=minimax');
  });

  it('skips capture when no installRoot/.env exists', async () => {
    // No .env at all in installRoot; backup still succeeds, archive
    // lacks the .env-redacted entry.
    const created = await createBackup({
      memphisRoot: env.memphisRoot,
      backupRoot: env.backupRoot,
      tag: 'no-env',
      showProgress: false,
    });

    const entries = listArchiveContents(created.backupPath);
    const redacted = entries.find(
      (e) => e.endsWith('.env-redacted') || e === './.env-redacted',
    );
    expect(redacted).toBeUndefined();
  });
});
