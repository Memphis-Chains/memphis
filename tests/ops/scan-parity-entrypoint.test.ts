import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';

import { expect, it } from 'vitest';

it('runs the scanner parity gate against the current native module layout', () => {
  const result = spawnSync(
    process.execPath,
    ['--import', resolve('node_modules/tsx/dist/loader.mjs'), 'scripts/check-scan-parity.mts'],
    { cwd: resolve('.'), encoding: 'utf8', timeout: 15000 },
  );
  expect(result.status, result.stdout + result.stderr).toBe(0);
  expect(result.stdout).toContain('[scan-parity] OK');
});
