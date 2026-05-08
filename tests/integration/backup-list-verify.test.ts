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

import {
  createBackup,
  verifyAllBackups,
} from '../../src/infra/cli/commands/backup.js';
import { resetInstallRootMemoForTests } from '../../src/infra/runtime/install-root.js';

interface TestEnv {
  memphisRoot: string;
  backupRoot: string;
  savedRuntimeRoot: string | undefined;
}

function setup(): TestEnv {
  const memphisRoot = mkdtempSync(join(tmpdir(), 'memphis-list-verify-'));
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
    JSON.stringify({ encryptedMasterKey: 'opaque-blob' }),
    'utf8',
  );
  writeFileSync(
    join(memphisRoot, '.env'),
    'MEMPHIS_VAULT_PEPPER=originalPepper123456\n',
    'utf8',
  );
  writeFileSync(
    join(memphisRoot, 'package.json'),
    JSON.stringify({ name: '@memphis-chains/memphis', version: '0.0.0-test' }),
    'utf8',
  );
  mkdirSync(backupRoot, { recursive: true });

  const savedRuntimeRoot = process.env.MEMPHIS_RUNTIME_ROOT;
  process.env.MEMPHIS_RUNTIME_ROOT = memphisRoot;
  resetInstallRootMemoForTests();

  return { memphisRoot, backupRoot, savedRuntimeRoot };
}

function teardown(env: TestEnv): void {
  if (env.savedRuntimeRoot === undefined) delete process.env.MEMPHIS_RUNTIME_ROOT;
  else process.env.MEMPHIS_RUNTIME_ROOT = env.savedRuntimeRoot;
  resetInstallRootMemoForTests();
  rmSync(env.memphisRoot, { recursive: true, force: true });
}

describe('backup verify-all sweep — P2 hotfix surface', () => {
  let env: TestEnv;

  beforeEach(() => {
    env = setup();
  });

  afterEach(() => {
    teardown(env);
  });

  it('reports all archives valid when none are tampered', async () => {
    await createBackup({
      memphisRoot: env.memphisRoot,
      backupRoot: env.backupRoot,
      tag: 'good-1',
      showProgress: false,
    });
    await createBackup({
      memphisRoot: env.memphisRoot,
      backupRoot: env.backupRoot,
      tag: 'good-2',
      showProgress: false,
    });

    const sweep = await verifyAllBackups({
      memphisRoot: env.memphisRoot,
      backupRoot: env.backupRoot,
    });
    expect(sweep.ok).toBe(true);
    expect(sweep.total).toBe(2);
    expect(sweep.validCount).toBe(2);
    expect(sweep.corruptCount).toBe(0);
    expect(sweep.results.every((r) => r.valid)).toBe(true);
  });

  it('identifies a tampered archive and flags ok=false', async () => {
    const good = await createBackup({
      memphisRoot: env.memphisRoot,
      backupRoot: env.backupRoot,
      tag: 'still-good',
      showProgress: false,
    });
    const corrupt = await createBackup({
      memphisRoot: env.memphisRoot,
      backupRoot: env.backupRoot,
      tag: 'soon-corrupt',
      showProgress: false,
    });

    // Tamper with the archive: flip the leading byte. Checksum will mismatch.
    const data = readFileSync(corrupt.backupPath);
    data[0] = (data[0] ?? 0) ^ 0xff;
    writeFileSync(corrupt.backupPath, data);

    const sweep = await verifyAllBackups({
      memphisRoot: env.memphisRoot,
      backupRoot: env.backupRoot,
    });

    expect(sweep.ok).toBe(false);
    expect(sweep.total).toBe(2);
    expect(sweep.validCount).toBe(1);
    expect(sweep.corruptCount).toBe(1);

    const goodResult = sweep.results.find((r) => r.file === good.file);
    const corruptResult = sweep.results.find((r) => r.file === corrupt.file);
    expect(goodResult?.valid).toBe(true);
    expect(corruptResult?.valid).toBe(false);
    // Checksum mismatch surfaces the actual hex so the operator can
    // cross-reference with the .sha256 sidecar.
    expect(corruptResult?.checksum.actual).toBeTruthy();
    expect(corruptResult?.checksum.expected).toBeTruthy();
    expect(corruptResult?.checksum.actual).not.toEqual(corruptResult?.checksum.expected);
  });

  it('reports total=0 when backup directory is empty', async () => {
    expect(existsSync(env.backupRoot)).toBe(true);
    const sweep = await verifyAllBackups({
      memphisRoot: env.memphisRoot,
      backupRoot: env.backupRoot,
    });
    expect(sweep.ok).toBe(true);
    expect(sweep.total).toBe(0);
    expect(sweep.validCount).toBe(0);
    expect(sweep.corruptCount).toBe(0);
  });
});
