import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

import { expect, it } from 'vitest';

it('checks CPU service readouts, exact cache isolation and inference scheduling', () => {
  const result = spawnSync(
    'python3',
    [
      fileURLToPath(new URL('./basal_cpu_service_test.py', import.meta.url)),
      fileURLToPath(new URL('../../scripts/basal/basal_cpu.py', import.meta.url)),
    ],
    {
      encoding: 'utf8',
      timeout: 15_000,
      env: { PATH: '/usr/local/bin:/usr/bin:/bin', HOME: tmpdir(), LANG: 'C.UTF-8' },
    },
  );
  expect(result.error, result.stderr).toBeUndefined();
  expect(result.status, result.stderr).toBe(0);
}, 20_000);
