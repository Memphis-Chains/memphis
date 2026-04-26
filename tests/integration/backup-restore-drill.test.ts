import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
  readdirSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createBackup, restoreBackup } from '../../src/infra/cli/commands/backup.js';
import { resetInstallRootMemoForTests } from '../../src/infra/runtime/install-root.js';

interface DrillEnv {
  memphisRoot: string;
  backupRoot: string;
}

function setupDrillEnv(): DrillEnv {
  const memphisRoot = mkdtempSync(join(tmpdir(), 'memphis-backup-drill-'));
  const backupRoot = join(memphisRoot, 'backups');
  mkdirSync(join(memphisRoot, 'chains', 'journal'), { recursive: true });
  mkdirSync(join(memphisRoot, 'vault'), { recursive: true });
  writeFileSync(
    join(memphisRoot, 'chains', 'journal', '000001.json'),
    JSON.stringify({ index: 1, content: 'genesis' }),
    'utf8',
  );
  writeFileSync(
    join(memphisRoot, 'vault', 'state.json'),
    JSON.stringify({ encryptedMasterKey: 'opaque-blob', salt: 'aaaa' }),
    'utf8',
  );
  writeFileSync(
    join(memphisRoot, '.env'),
    'MEMPHIS_VAULT_PEPPER=originalPepper123456\nGEN_MAX_TOKENS=1024\n',
    'utf8',
  );
  // The pepper-restore path now anchors on `resolveInstallRoot()` (PR #294),
  // which validates that the candidate dir has a `package.json` with name
  // `@memphis-chains/memphis`. Drop a marker package.json into memphisRoot
  // so the test's tmpdir is a valid install root, then point the resolver
  // at it via MEMPHIS_RUNTIME_ROOT.
  writeFileSync(
    join(memphisRoot, 'package.json'),
    JSON.stringify({ name: '@memphis-chains/memphis', version: '0.0.0-test' }),
    'utf8',
  );
  mkdirSync(backupRoot, { recursive: true });
  return { memphisRoot, backupRoot };
}

function tearDown(env: DrillEnv): void {
  rmSync(env.memphisRoot, { recursive: true, force: true });
}

describe('backup → wipe → restore round trip', () => {
  let env: DrillEnv;

  let savedRuntimeRoot: string | undefined;

  beforeEach(() => {
    env = setupDrillEnv();
    savedRuntimeRoot = process.env.MEMPHIS_RUNTIME_ROOT;
    process.env.MEMPHIS_RUNTIME_ROOT = env.memphisRoot;
    resetInstallRootMemoForTests();
  });

  afterEach(() => {
    if (savedRuntimeRoot === undefined) delete process.env.MEMPHIS_RUNTIME_ROOT;
    else process.env.MEMPHIS_RUNTIME_ROOT = savedRuntimeRoot;
    resetInstallRootMemoForTests();
    tearDown(env);
  });

  it('preserves chain blocks and vault state across restore', async () => {
    const created = await createBackup({
      memphisRoot: env.memphisRoot,
      backupRoot: env.backupRoot,
      tag: 'drill',
      showProgress: false,
    });
    expect(existsSync(created.backupPath)).toBe(true);

    const journalDir = join(env.memphisRoot, 'chains', 'journal');
    const vaultPath = join(env.memphisRoot, 'vault', 'state.json');
    rmSync(journalDir, { recursive: true, force: true });
    rmSync(vaultPath, { force: true });
    expect(existsSync(journalDir)).toBe(false);
    expect(existsSync(vaultPath)).toBe(false);

    const restored = await restoreBackup({
      file: created.file,
      memphisRoot: env.memphisRoot,
      backupRoot: env.backupRoot,
      confirm: true,
      showProgress: false,
    });
    expect(restored.ok).toBe(true);

    const restoredBlock = JSON.parse(readFileSync(join(journalDir, '000001.json'), 'utf8')) as {
      index: number;
      content: string;
    };
    expect(restoredBlock.index).toBe(1);
    expect(restoredBlock.content).toBe('genesis');

    const restoredVault = JSON.parse(readFileSync(vaultPath, 'utf8')) as {
      encryptedMasterKey: string;
    };
    expect(restoredVault.encryptedMasterKey).toBe('opaque-blob');

    const envText = readFileSync(join(env.memphisRoot, '.env'), 'utf8');
    expect(envText).toContain('MEMPHIS_VAULT_PEPPER=originalPepper123456');
  });

  it('writes a pre-restore safety backup before swapping in the new contents', async () => {
    const created = await createBackup({
      memphisRoot: env.memphisRoot,
      backupRoot: env.backupRoot,
      tag: 'drill-pre',
      showProgress: false,
    });
    const restored = await restoreBackup({
      file: created.file,
      memphisRoot: env.memphisRoot,
      backupRoot: env.backupRoot,
      confirm: true,
      showProgress: false,
    });
    expect(restored.preRestoreBackup).toMatch(/^pre-restore-/);
    const archives = readdirSync(env.backupRoot).filter((f) => f.endsWith('.tar.gz'));
    expect(archives.some((f) => f.startsWith('pre-restore-'))).toBe(true);
  });
});

describe('--pepper-restore for cross-host vault recovery', () => {
  let env: DrillEnv;

  let savedRuntimeRoot: string | undefined;

  beforeEach(() => {
    env = setupDrillEnv();
    savedRuntimeRoot = process.env.MEMPHIS_RUNTIME_ROOT;
    process.env.MEMPHIS_RUNTIME_ROOT = env.memphisRoot;
    resetInstallRootMemoForTests();
  });

  afterEach(() => {
    if (savedRuntimeRoot === undefined) delete process.env.MEMPHIS_RUNTIME_ROOT;
    else process.env.MEMPHIS_RUNTIME_ROOT = savedRuntimeRoot;
    resetInstallRootMemoForTests();
    tearDown(env);
  });

  it('rewrites MEMPHIS_VAULT_PEPPER in the restored .env when supplied', async () => {
    const created = await createBackup({
      memphisRoot: env.memphisRoot,
      backupRoot: env.backupRoot,
      tag: 'cross-host',
      showProgress: false,
    });

    writeFileSync(
      join(env.memphisRoot, '.env'),
      'MEMPHIS_VAULT_PEPPER=destinationPepperABC\n',
      'utf8',
    );

    await restoreBackup({
      file: created.file,
      memphisRoot: env.memphisRoot,
      backupRoot: env.backupRoot,
      confirm: true,
      showProgress: false,
      pepperRestore: 'sourceHostPepperXYZ123',
    });

    const envText = readFileSync(join(env.memphisRoot, '.env'), 'utf8');
    expect(envText).toContain('MEMPHIS_VAULT_PEPPER=sourceHostPepperXYZ123');
    expect(envText).not.toContain('destinationPepperABC');
    expect(envText).not.toContain('originalPepper123456');
  });

  it('rejects pepper values shorter than 12 characters', async () => {
    const created = await createBackup({
      memphisRoot: env.memphisRoot,
      backupRoot: env.backupRoot,
      tag: 'short-pepper',
      showProgress: false,
    });

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
  });

  it('does not modify .env when --pepper-restore is omitted', async () => {
    const created = await createBackup({
      memphisRoot: env.memphisRoot,
      backupRoot: env.backupRoot,
      tag: 'no-pepper-flag',
      showProgress: false,
    });

    writeFileSync(
      join(env.memphisRoot, '.env'),
      'MEMPHIS_VAULT_PEPPER=destinationPepperABC\n',
      'utf8',
    );

    await restoreBackup({
      file: created.file,
      memphisRoot: env.memphisRoot,
      backupRoot: env.backupRoot,
      confirm: true,
      showProgress: false,
    });

    const envText = readFileSync(join(env.memphisRoot, '.env'), 'utf8');
    expect(envText).toContain('MEMPHIS_VAULT_PEPPER=originalPepper123456');
  });
});
