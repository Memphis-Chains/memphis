import { describe, expect, it } from 'vitest';

import { resolveBootstrapEnvPath } from '../../src/app/bootstrap.js';

describe('bootstrap env-file resolution', () => {
  it('defaults to repo .env when no explicit env file is configured', () => {
    expect(resolveBootstrapEnvPath({})).toBe('.env');
  });

  it('honors MEMPHIS_ENV_FILE for isolated runtime boot paths', () => {
    expect(resolveBootstrapEnvPath({ MEMPHIS_ENV_FILE: '/tmp/memphis-rc/.env' })).toBe(
      '/tmp/memphis-rc/.env',
    );
  });
});
