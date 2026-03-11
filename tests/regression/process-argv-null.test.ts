import { describe, expect, it } from 'vitest';

import { runCli } from '../../src/infra/cli/index.js';

describe('CLI process.argv safety regression', () => {
  it('does not crash when process.argv is undefined and runCli uses default argv', async () => {
    const previousArgv = process.argv;
    const previousEnv = process.env;

    process.env = {
      ...previousEnv,
      NODE_ENV: 'test',
      MEMPHIS_SKIP_FIRST_RUN_CHECKS: '1',
    };

    try {
      (process as unknown as { argv?: string[] }).argv = undefined;
      await expect(runCli()).resolves.toBeUndefined();
    } finally {
      process.argv = previousArgv;
      process.env = previousEnv;
    }
  });
});
