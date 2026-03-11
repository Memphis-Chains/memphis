import { afterEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { DecisionInference } from '../../src/cognitive/decision-inference.js';

const cleanup: string[] = [];

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
  }).trim();
}

function makeRepoWithPatternedCommits(): string {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'model-c-'));
  cleanup.push(repo);

  git(repo, 'init');
  git(repo, 'config', 'user.name', 'Model C Test');
  git(repo, 'config', 'user.email', 'model-c@test.local');

  fs.writeFileSync(path.join(repo, 'base.txt'), 'init\n');
  git(repo, 'add', 'base.txt');
  git(repo, 'commit', '-m', 'chore: init');

  for (let index = 0; index < 8; index += 1) {
    fs.writeFileSync(path.join(repo, `feat-${index}.ts`), `export const f${index} = ${index};\n`);
    git(repo, 'add', `feat-${index}.ts`);
    git(repo, 'commit', '-m', `feat: add module ${index}`);
  }

  for (let index = 0; index < 2; index += 1) {
    fs.writeFileSync(path.join(repo, `fix-${index}.ts`), `export const x${index} = ${index};\n`);
    git(repo, 'add', `fix-${index}.ts`);
    git(repo, 'commit', '-m', `fix: patch bug ${index}`);
  }

  return repo;
}

afterEach(() => {
  while (cleanup.length > 0) {
    const dir = cleanup.pop();
    if (dir && fs.existsSync(dir)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
});

describe('DecisionInference (Model C)', () => {
  it('records inferred decisions and skips duplicates', async () => {
    const repo = makeRepoWithPatternedCommits();
    const history = path.join(repo, 'decision-history.jsonl');
    const model = new DecisionInference({ repoPath: repo, historyPath: history, maxCommits: 50 });

    const first = await model.inferFromGit(365);
    const second = await model.inferFromGit(365);

    expect(first).toBeGreaterThan(0);
    expect(second).toBe(0);
    expect(model.checkDecisionExists(`git-${git(repo, 'rev-parse', 'HEAD').slice(0, 16)}`)).toBe(
      true,
    );
  });

  it('predicts next decision and reaches >=70% backtest accuracy on patterned history', async () => {
    const repo = makeRepoWithPatternedCommits();
    const history = path.join(repo, 'decision-history.jsonl');
    const model = new DecisionInference({ repoPath: repo, historyPath: history, maxCommits: 50 });

    await model.inferFromGit(365);
    const prediction = await model.predictNextDecision();
    const accuracy = model.evaluatePredictionAccuracy(20);

    expect(prediction.type).toBe('feature');
    expect(prediction.confidence).toBeGreaterThan(0.7);
    expect(accuracy).toBeGreaterThanOrEqual(0.7);
  });
});
