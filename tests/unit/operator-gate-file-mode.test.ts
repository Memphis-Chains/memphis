import { mkdtempSync, rmSync, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { saveOperatorConfig } from '../../src/infra/auth/operator-gate.ts';

/**
 * Regression net for #135: operator.json contains the PBKDF2 salt + hash
 * of the operator passphrase (and recovery answer). It MUST be 0o600 so
 * no other local user can crack it offline.
 */

describe('operator-gate — file mode (#135)', () => {
  let tmpDir: string;
  let origEnv: NodeJS.ProcessEnv;

  beforeEach(() => {
    tmpDir = mkdtempSync(path.join(os.tmpdir(), 'memphis-opergate-'));
    origEnv = { ...process.env };
    process.env.MEMPHIS_DATA_DIR = tmpDir;
  });

  afterEach(() => {
    process.env = origEnv;
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('writes operator.json with mode 0o600', () => {
    const config = {
      schemaVersion: 1,
      passphraseHash: 'deadbeef'.repeat(8),
      salt: 'cafebabe'.repeat(4),
      createdAt: '2026-04-16T00:00:00.000Z',
      updatedAt: '2026-04-16T00:00:00.000Z',
      recoveryQuestionHint: 'q',
      recoveryHash: 'deadbeef'.repeat(8),
    };

    saveOperatorConfig(config);

    const filePath = path.join(tmpDir, 'config', 'operator.json');
    const mode = statSync(filePath).mode & 0o777;
    expect(mode).toBe(0o600);
  });

  it('directory is created with mode 0o700', () => {
    const config = {
      schemaVersion: 1,
      passphraseHash: 'deadbeef'.repeat(8),
      salt: 'cafebabe'.repeat(4),
      createdAt: '2026-04-16T00:00:00.000Z',
      updatedAt: '2026-04-16T00:00:00.000Z',
      recoveryQuestionHint: 'q',
      recoveryHash: 'deadbeef'.repeat(8),
    };

    saveOperatorConfig(config);

    const dirPath = path.join(tmpDir, 'config');
    const mode = statSync(dirPath).mode & 0o777;
    expect(mode).toBe(0o700);
  });
});
