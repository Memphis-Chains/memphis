import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { expect, it } from 'vitest';

it('preserves the hook repository when the mutation gate creates scratch commits', () => {
  const root = mkdtempSync(join(tmpdir(), 'memphis-hook-git-'));
  const env = Object.fromEntries(
    Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_')),
  );
  try {
    execFileSync('git', ['init', '-q', root], { env });
    writeFileSync(join(root, 'operator-change.txt'), 'staged operator work\n');
    execFileSync('git', ['-C', root, 'add', 'operator-change.txt'], { env });
    const paths = ['config', 'index', 'HEAD'].map((name) => join(root, '.git', name));
    const before = paths.map((path) => readFileSync(path));
    const sources = [
      'scripts/pii-scan.sh',
      'sites/memphis-v5/index.html',
      'crates/memphis-operator/src/chat_tool_catalog.rs',
      'src/security/content-scan.ts',
    ];
    const sourceBytes = sources.map((path) => readFileSync(path));
    const result = spawnSync(
      process.execPath,
      ['--import', resolve('node_modules/tsx/dist/loader.mjs'), 'scripts/mutation-gate.mts'],
      {
        cwd: resolve('.'),
        env: {
          ...env,
          GIT_DIR: join(root, '.git'),
          GIT_WORK_TREE: root,
          GIT_INDEX_FILE: join(root, '.git', 'index'),
        },
        encoding: 'utf8',
        timeout: 60000,
      },
    );
    expect(result.status, result.stdout + result.stderr).toBe(0);
    expect(result.stdout).toContain('5/5 mutations killed');
    paths.forEach((path, index) => expect(readFileSync(path)).toEqual(before[index]));
    sources.forEach((path, index) => expect(readFileSync(path)).toEqual(sourceBytes[index]));
    const head = spawnSync('git', ['-C', root, 'rev-parse', '--verify', 'HEAD'], { env });
    expect(head.status).not.toBe(0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}, 90000);
