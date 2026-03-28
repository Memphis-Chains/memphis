import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { runCli } from '../helpers/cli.js';

const cleanup: string[] = [];

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
  }).trim();
}

function createGitRepo(): string {
  const repo = mkdtempSync(join(tmpdir(), 'memphis-cli-git-stats-'));
  cleanup.push(repo);

  git(repo, 'init');
  git(repo, 'config', 'user.name', 'Memphis CLI Test');
  git(repo, 'config', 'user.email', 'cli@test.local');
  writeFileSync(join(repo, 'README.md'), '# test\n', 'utf8');
  git(repo, 'add', 'README.md');
  git(repo, 'commit', '-m', 'docs: add test readme');

  return repo;
}

afterEach(() => {
  while (cleanup.length > 0) {
    const dir = cleanup.pop();
    if (dir) {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

describe('CLI git-stats legacy contract', () => {
  it('reports git-stats as a legacy debug surface with chain truth unchanged', async () => {
    const repo = createGitRepo();
    const out = await runCli(['git-stats', '--days', '365', '--json'], {
      cwd: repo,
      env: {
        MEMPHIS_DATA_DIR: join(repo, '.memphis'),
      },
    });

    const data = JSON.parse(out) as {
      ok: boolean;
      mode: string;
      lane: string;
      scope: string;
      deprecated: boolean;
      sourceOfTruth: string;
      note: string;
      stats: { total: number };
    };

    expect(data.ok).toBe(true);
    expect(data.mode).toBe('git-stats-legacy');
    expect(data.lane).toBe('legacy-git-debug');
    expect(data.scope).toBe('debug');
    expect(data.deprecated).toBe(true);
    expect(data.sourceOfTruth).toBe('chains');
    expect(data.note).toContain('do not drive Memphis runtime cognition');
    expect(data.stats.total).toBeGreaterThan(0);
  });
});
