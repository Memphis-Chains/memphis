import { afterEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execSync } from 'node:child_process';
import { DecisionInference } from '../../src/cognitive/decision-inference.js';

const cleanup: string[] = [];

function sh(command: string, cwd: string): string {
  return execSync(command, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

function makeRepoWithPatternedCommits(): string {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'model-c-'));
  cleanup.push(repo);

  sh('git init', repo);
  sh('git config user.name "Model C Test"', repo);
  sh('git config user.email "model-c@test.local"', repo);

  fs.writeFileSync(path.join(repo, 'base.txt'), 'init\n');
  sh('git add base.txt', repo);
  sh('git commit -m "chore: init"', repo);

  for (let i = 0; i < 8; i += 1) {
    fs.writeFileSync(path.join(repo, `feat-${i}.ts`), `export const f${i} = ${i};\n`);
    sh(`git add feat-${i}.ts`, repo);
    sh(`git commit -m "feat: add module ${i}"`, repo);
  }

  for (let i = 0; i < 2; i += 1) {
    fs.writeFileSync(path.join(repo, `fix-${i}.ts`), `export const x${i} = ${i};\n`);
    sh(`git add fix-${i}.ts`, repo);
    sh(`git commit -m "fix: patch bug ${i}"`, repo);
  }

  return repo;
}

afterEach(() => {
  while (cleanup.length > 0) {
    const dir = cleanup.pop();
    if (dir && fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
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
    expect(model.checkDecisionExists('git-' + sh('git rev-parse HEAD', repo).slice(0, 16))).toBe(true);
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
