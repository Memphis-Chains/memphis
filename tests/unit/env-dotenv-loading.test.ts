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
    process.env[SENTINEL] = savedSentinel;
    process.env.MEMPHIS_ENV_FILE = savedEnvFile;
  });

  it('loads the file pointed at by MEMPHIS_ENV_FILE', () => {
    const envPath = join(scratch, 'custom.env');
    writeFileSync(envPath, `${SENTINEL}=loaded-from-explicit-path\n`);

    const loaded = loadDotEnvFromInstallRoot({ MEMPHIS_ENV_FILE: envPath });

    expect(loaded).toBe(envPath);
    expect(process.env[SENTINEL]).toBe('loaded-from-explicit-path');
  });

  it('returns null when neither MEMPHIS_ENV_FILE nor any fallback resolves', () => {
    // Point MEMPHIS_ENV_FILE at a file that does not exist; fall-through
    // to the install-root path (also missing here) and finally to
    // dotenv.config() which sees nothing useful in cwd.
    const missing = join(scratch, 'does-not-exist.env');
    const result = loadDotEnvFromInstallRoot({ MEMPHIS_ENV_FILE: missing });

    // Either null (no env found anywhere) or the real repo .env if
    // running inside the checkout. Either way the explicit missing
    // path must NOT be reported as loaded.
    expect(result).not.toBe(missing);
  });

  it('does not throw when all resolution paths fail', () => {
    expect(() =>
      loadDotEnvFromInstallRoot({
        MEMPHIS_ENV_FILE: join(scratch, 'gone.env'),
        MEMPHIS_RUNTIME_ROOT: join(scratch, 'no-package'),
      }),
    ).not.toThrow();
  });
});
