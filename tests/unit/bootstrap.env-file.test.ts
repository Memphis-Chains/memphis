import { describe, expect, it } from 'vitest';

import { resolveBootstrapEnvPath } from '../../src/app/bootstrap.js';

describe('bootstrap env-file resolution', () => {
  it('defaults to `<installRoot>/.env` when no explicit env file is configured', () => {
    // `resolveBootstrapEnvPath` now routes through the shared
    // `resolveDotEnvPath` so bootstrap reads the same file that
    // config writes target. Previously returned the cwd-relative
    // `.env` literal; now returns an absolute path anchored on the
    // install root.
    const result = resolveBootstrapEnvPath({});
    expect(result).toMatch(/\.env$/);
    expect(result.startsWith('/')).toBe(true);
  });

  it('honors MEMPHIS_ENV_FILE for isolated runtime boot paths', () => {
    expect(resolveBootstrapEnvPath({ MEMPHIS_ENV_FILE: '/tmp/memphis-rc/.env' })).toBe(
      '/tmp/memphis-rc/.env',
    );
  });
});
