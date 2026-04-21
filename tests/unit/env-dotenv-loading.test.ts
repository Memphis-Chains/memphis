import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { loadDotEnvFromInstallRoot } from '../../src/infra/config/env.js';

const SENTINEL = 'MEMPHIS_DOTENV_LOAD_SENTINEL';

describe('loadDotEnvFromInstallRoot', () => {
  let savedSentinel: string | undefined;
  let savedEnvFile: string | undefined;
  let scratch = '';

  beforeEach(() => {
    savedSentinel = process.env[SENTINEL];
    savedEnvFile = process.env.MEMPHIS_ENV_FILE;
    delete process.env[SENTINEL];
    delete process.env.MEMPHIS_ENV_FILE;
    scratch = mkdtempSync(join(tmpdir(), 'memphis-env-loader-'));
  });

  afterEach(() => {
    // `process.env[key] = undefined` stores the literal string
    // 'undefined' in Node, not unset — delete explicitly when the
    // saved value was undefined. (Codex P2 on #225.)
    if (savedSentinel === undefined) delete process.env[SENTINEL];
    else process.env[SENTINEL] = savedSentinel;
    if (savedEnvFile === undefined) delete process.env.MEMPHIS_ENV_FILE;
    else process.env.MEMPHIS_ENV_FILE = savedEnvFile;
  });

  it('loads the file pointed at by MEMPHIS_ENV_FILE', () => {
    const envPath = join(scratch, 'custom.env');
    writeFileSync(envPath, `${SENTINEL}=loaded-from-explicit-path\n`);

    const loaded = loadDotEnvFromInstallRoot({ MEMPHIS_ENV_FILE: envPath });

    expect(loaded).toBe(envPath);
    expect(process.env[SENTINEL]).toBe('loaded-from-explicit-path');
  });

  it('returns null when MEMPHIS_ENV_FILE points at a non-existent path', () => {
    // Fail-closed: do NOT silently re-fall-back to cwd dotenv.config(),
    // which would reintroduce cwd-dependence and potentially read an
    // unrelated .env. (Codex P1 on #225.)
    const missing = join(scratch, 'does-not-exist.env');
    const result = loadDotEnvFromInstallRoot({ MEMPHIS_ENV_FILE: missing });
    expect(result).toBeNull();
  });

  it('does not throw when all resolution paths fail', () => {
    expect(() =>
      loadDotEnvFromInstallRoot({
        MEMPHIS_ENV_FILE: join(scratch, 'gone.env'),
        MEMPHIS_RUNTIME_ROOT: join(scratch, 'no-package'),
      }),
    ).not.toThrow();
  });

  it('returns null when the resolved file is unreadable (dotenv parse error)', () => {
    // Use a path that exists but is actually a directory — dotenv's
    // readFileSync raises EISDIR and result.error is set.
    const notAFile = scratch; // `scratch` is a directory
    const result = loadDotEnvFromInstallRoot({ MEMPHIS_ENV_FILE: notAFile });
    expect(result).toBeNull();
  });
});
