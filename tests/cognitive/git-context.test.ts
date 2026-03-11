import { execFileSync } from 'node:child_process';

import { describe, expect, it, vi } from 'vitest';

import { GitContext } from '../../src/cognitive/git-context.js';

vi.mock('node:child_process', () => ({
  execFileSync: vi.fn(),
}));

describe('GitContext', () => {
  it('parses commits and files from git log output', () => {
    const mockedExecFileSync = vi.mocked(execFileSync);
    mockedExecFileSync.mockImplementation((_file: string, args?: readonly string[]) => {
      if (args?.includes('rev-parse')) return '.git' as never;
      return `__COMMIT__|abc123|Alice|alice@example.com|1700000000|feat: add api client\nsrc/api.ts\nREADME.md\n__COMMIT__|def456|Bob|bob@example.com|1700000500|fix: patch auth bug\nsrc/auth.ts\n` as never;
    });

    const ctx = new GitContext('/tmp/repo');
    const commits = ctx.getRecentCommits(5);

    expect(commits).toHaveLength(2);
    expect(commits[0]?.hash).toBe('abc123');
    expect(commits[0]?.files).toEqual(['src/api.ts', 'README.md']);
    expect(commits[1]?.message).toBe('fix: patch auth bug');
  });

  it('extracts inferred decision with expected type/category', () => {
    const ctx = new GitContext('/tmp/repo');
    const decision = ctx.extractDecision({
      hash: '1234567890abcdef',
      author: 'Dev',
      email: 'dev@example.com',
      timestamp: new Date(),
      message: 'fix: resolve API issue',
      files: ['src/http.ts'],
    });

    expect(decision.decisionId).toBe('git-1234567890abcdef');
    expect(decision.chosen).toBe('bugfix');
    expect(decision.context.category).toBe('api');
  });
});
