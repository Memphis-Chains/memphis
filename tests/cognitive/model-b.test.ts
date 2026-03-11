import { afterEach, describe, expect, it } from 'vitest';
import { execSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { Block } from '../../src/memory/chain.js';
import { ModelB_InferredDecisions } from '../../src/cognitive/model-b.js';

const reposToCleanup: string[] = [];

function sh(command: string, cwd: string): string {
  return execSync(command, { cwd, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

function makeRepoWithCommits(): string {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'model-b-'));
  reposToCleanup.push(repo);

  sh('git init', repo);
  sh('git config user.name "Model B Test"', repo);
  sh('git config user.email "model-b@test.local"', repo);

  fs.writeFileSync(path.join(repo, 'README.md'), '# test\n');
  sh('git add README.md', repo);
  sh('git commit -m "chore: init repo"', repo);

  fs.writeFileSync(path.join(repo, 'package.json'), JSON.stringify({ name: 'x', version: '1.0.0' }, null, 2));
  sh('git add package.json', repo);
  sh('git commit -m "feat: add auth module"', repo);

  fs.mkdirSync(path.join(repo, 'src'), { recursive: true });
  fs.writeFileSync(path.join(repo, 'src', 'service.ts'), 'export const x = 1;\n');
  sh('git add src/service.ts', repo);
  sh('git commit -m "refactor: service layer to strategy pattern"', repo);

  fs.writeFileSync(path.join(repo, 'tsconfig.json'), JSON.stringify({ compilerOptions: { strict: true } }, null, 2));
  sh('git add tsconfig.json', repo);
  sh('git commit -m "fix: align ts settings"', repo);

  return repo;
}

afterEach(() => {
  while (reposToCleanup.length > 0) {
    const repo = reposToCleanup.pop();
    if (repo && fs.existsSync(repo)) {
      fs.rmSync(repo, { recursive: true, force: true });
    }
  }
});

describe('Model B inferred decisions', () => {
  it('infers decisions from git commit messages', () => {
    const repo = makeRepoWithCommits();
    const model = new ModelB_InferredDecisions({ repoPath: repo, sinceDays: 30, confidenceThreshold: 0.4 });

    const out = model.inferFromGit();
    expect(out.length).toBeGreaterThan(0);
    expect(out.some((d) => d.source === 'git')).toBe(true);
    expect(out.some((d) => d.title.includes('Refactoring strategy') || d.title.includes('Feature direction'))).toBe(true);
    expect(out.every((d) => d.confidence <= 0.9 && d.confidence >= 0.2)).toBe(true);
  });

  it('infers decisions from file-change patterns', () => {
    const repo = makeRepoWithCommits();
    const model = new ModelB_InferredDecisions({ repoPath: repo, sinceDays: 30, confidenceThreshold: 0.4 });

    const out = model.inferFromFileChanges();
    const titles = out.map((d) => d.title);

    expect(out.length).toBeGreaterThan(0);
    expect(titles).toContain('Dependency strategy updated');
    expect(titles).toContain('Compiler/runtime constraints changed');
  });

  it('infers task-shift decisions from activity', () => {
    const base = Date.now() - 60 * 60 * 1000;
    const mk = (i: number, tags: string[]): Block => ({
      timestamp: new Date(base + i * 60_000).toISOString(),
      chain: 'journal',
      data: { content: `entry ${i}`, tags },
    });

    const blocks: Block[] = [
      mk(1, ['project:alpha', 'work']),
      mk(2, ['project:alpha']),
      mk(3, ['project:alpha', 'coding']),
      mk(4, ['project:alpha']),
      mk(5, ['project:beta', 'ops']),
      mk(6, ['project:beta']),
      mk(7, ['project:beta', 'ops']),
      mk(8, ['project:beta']),
    ];

    const model = new ModelB_InferredDecisions({ activityWindowSize: 4, confidenceThreshold: 0.3 });
    const out = model.inferFromActivity(blocks);

    expect(out.length).toBeGreaterThan(0);
    expect(out.some((d) => d.title.startsWith('Task focus shifted:'))).toBe(true);
  });
});
