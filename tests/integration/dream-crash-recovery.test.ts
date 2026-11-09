import { execFile, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

import { expect, it } from 'vitest';

const exec = promisify(execFile);
const bridge = process.env.MEMPHIS_TEST_NATIVE_BRIDGE ?? join(process.cwd(), 'crates', 'memphis-napi');
const dependenciesAvailable = existsSync(join(bridge, 'index.node')) &&
  spawnSync('python3', ['--version']).status === 0;

it.skipIf(!dependenciesAvailable)('recovers a killed proposal application around file and chain publication on both backends', async () => {
  const { stdout } = await exec('python3', [join(process.cwd(), 'tests', 'fixtures', 'dream-crash-recovery.py')], {
    cwd: process.cwd(), timeout: 180_000, maxBuffer: 512 * 1024,
    env: { PATH: process.env.PATH, HOME: tmpdir(), NODE_ENV: 'test', MEMPHIS_TEST_NATIVE_BRIDGE: bridge },
  });
  const outcomes = JSON.parse(stdout) as Array<{ backend: string; killed: string; journal_before: string;
    reconcile: string; retry: string; retained: string[] }>;
  expect(outcomes).toHaveLength(8);
  for (const backend of ['typescript', 'napi']) {
    expect(outcomes.find((item) => item.backend === backend && item.killed === 'before')).toMatchObject({
      journal_before: 'staged', reconcile: 'not-applied', retry: 'applied', retained: ['synthetic learning'],
    });
    expect(outcomes.find((item) => item.backend === backend && item.killed === 'after')).toMatchObject({
      journal_before: 'staged', reconcile: 'applied', retry: 'already-applied', retained: ['synthetic learning'],
    });
    expect(outcomes.find((item) => item.backend === backend && item.killed === 'before-chain')).toMatchObject({
      journal_before: 'applied', reconcile: 'accepted', retry: 'already-applied', retained: ['synthetic learning'],
    });
    expect(outcomes.find((item) => item.backend === backend && item.killed === 'after-chain')).toMatchObject({
      journal_before: 'applied', reconcile: 'applied', retry: 'already-applied', retained: ['synthetic learning'],
    });
  }
}, 190_000);
