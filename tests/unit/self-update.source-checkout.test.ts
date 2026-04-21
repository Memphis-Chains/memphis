import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  checkSourceUpdate,
  computePackageLockChanged,
  detectSourceCheckout,
  installSourceUpdate,
  type SourceRunner,
} from '../../src/infra/self-update/source-checkout.js';

type RunnerCall = { command: string; args: string[]; cwd?: string };

function makeRunner(
  responses: Record<string, { stdout?: string; stderr?: string; status?: number }>,
): { runner: SourceRunner; calls: RunnerCall[] } {
  const calls: RunnerCall[] = [];
  const runner: SourceRunner = (command, args, options) => {
    calls.push({ command, args, cwd: options?.cwd });
    const key = [command, ...args].join(' ');
    const match = responses[key];
    const payload = match ?? { status: 0, stdout: '', stderr: '' };
    return {
      stdout: payload.stdout ?? '',
      stderr: payload.stderr ?? '',
      status: payload.status ?? 0,
      signal: null,
      pid: 0,
      output: [null, null, null],
    } as unknown as ReturnType<SourceRunner>;
  };
  return { runner, calls };
}

function makeFakeCheckout(): string {
  const root = mkdtempSync(join(tmpdir(), 'memphis-source-update-'));
  mkdirSync(join(root, '.git'));
  writeFileSync(join(root, 'package-lock.json'), '{"lockfileVersion":3}');
  return root;
}

describe('detectSourceCheckout', () => {
  it('returns isSource=false when .git is missing', () => {
    const root = mkdtempSync(join(tmpdir(), 'memphis-no-git-'));
    const { runner } = makeRunner({});
    const result = detectSourceCheckout(root, runner);
    expect(result.isSource).toBe(false);
    expect(result.reason).toContain('.git');
  });

  it('returns isSource=true with head+branch when git responds', () => {
    const root = makeFakeCheckout();
    const { runner } = makeRunner({
      'git rev-parse --abbrev-ref HEAD': { stdout: 'main\n' },
      'git rev-parse HEAD': { stdout: 'abcdef1\n' },
      'git config --get remote.origin.url': {
        stdout: 'https://github.com/Memphis-Chains/memphis.git\n',
      },
    });
    const result = detectSourceCheckout(root, runner);
    expect(result.isSource).toBe(true);
    expect(result.branch).toBe('main');
    expect(result.head).toBe('abcdef1');
    expect(result.remote).toContain('Memphis-Chains/memphis');
  });
});

describe('checkSourceUpdate', () => {
  it('reports updateAvailable=false when HEAD equals origin/main', () => {
    const root = makeFakeCheckout();
    const { runner } = makeRunner({
      'git rev-parse --abbrev-ref HEAD': { stdout: 'main\n' },
      'git rev-parse HEAD': { stdout: 'abcdef1\n' },
      'git config --get remote.origin.url': { stdout: 'origin\n' },
      'git fetch --quiet origin': { stdout: '' },
      'git rev-parse origin/main': { stdout: 'abcdef1\n' },
    });
    const result = checkSourceUpdate(root, runner);
    expect(result.ok).toBe(true);
    expect(result.updateAvailable).toBe(false);
    expect(result.commitsBehind).toBe(0);
  });

  it('lists pending commit subjects when behind origin', () => {
    const root = makeFakeCheckout();
    const { runner } = makeRunner({
      'git rev-parse --abbrev-ref HEAD': { stdout: 'main\n' },
      'git rev-parse HEAD': { stdout: 'aaaa111\n' },
      'git config --get remote.origin.url': { stdout: 'origin\n' },
      'git fetch --quiet origin': { stdout: '' },
      'git rev-parse origin/main': { stdout: 'bbbb222\n' },
      'git log --pretty=%s aaaa111..bbbb222': {
        stdout: 'fix(a): first\nfeat(b): second\n',
      },
    });
    const result = checkSourceUpdate(root, runner);
    expect(result.updateAvailable).toBe(true);
    expect(result.commitsBehind).toBe(2);
    expect(result.subjects).toEqual(['fix(a): first', 'feat(b): second']);
  });

  it('surfaces a fetch failure through error', () => {
    const root = makeFakeCheckout();
    const { runner } = makeRunner({
      'git rev-parse --abbrev-ref HEAD': { stdout: 'main\n' },
      'git rev-parse HEAD': { stdout: 'abcdef1\n' },
      'git config --get remote.origin.url': { stdout: 'origin\n' },
      'git fetch --quiet origin': { status: 1, stderr: 'could not resolve host' },
    });
    const result = checkSourceUpdate(root, runner);
    expect(result.ok).toBe(false);
    expect(result.error).toContain('could not resolve host');
  });

  it('falls back to @{upstream} with a warning when origin/<branch> does not exist', () => {
    // Codex on #212: some operator setups push through a fork, so
    // `origin/<branch>` may not resolve but a configured upstream
    // does. Verify the fallback picks the upstream ref and attaches
    // a warning — we don't want to silently resolve to a ref the
    // operator didn't set.
    const root = makeFakeCheckout();
    const { runner } = makeRunner({
      'git rev-parse --abbrev-ref HEAD': { stdout: 'dev-branch\n' },
      'git rev-parse HEAD': { stdout: 'aaaa111\n' },
      'git config --get remote.origin.url': { stdout: 'origin\n' },
      'git fetch --quiet origin': { stdout: '' },
      'git rev-parse --verify origin/dev-branch': { status: 1, stderr: 'unknown revision' },
      'git rev-parse --abbrev-ref dev-branch@{upstream}': {
        stdout: 'upstream/dev-branch\n',
      },
      'git rev-parse upstream/dev-branch': { stdout: 'bbbb222\n' },
      'git log --pretty=%s aaaa111..bbbb222': { stdout: 'feat: x\n' },
    });
    const result = checkSourceUpdate(root, runner);
    expect(result.ok).toBe(true);
    expect(result.updateAvailable).toBe(true);
    expect(result.warnings?.some((w) => w.includes('upstream/dev-branch'))).toBe(true);
  });

  it('reports a no-upstream error when neither origin nor @{upstream} resolve', () => {
    const root = makeFakeCheckout();
    const { runner } = makeRunner({
      'git rev-parse --abbrev-ref HEAD': { stdout: 'local-only\n' },
      'git rev-parse HEAD': { stdout: 'aaaa111\n' },
      'git config --get remote.origin.url': { stdout: 'origin\n' },
      'git fetch --quiet origin': { stdout: '' },
      'git rev-parse --verify origin/local-only': { status: 1, stderr: 'unknown revision' },
      'git rev-parse --abbrev-ref local-only@{upstream}': {
        status: 128,
        stderr: 'fatal: no upstream configured for branch local-only',
      },
    });
    const result = checkSourceUpdate(root, runner);
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/no upstream/);
  });
});

describe('computePackageLockChanged', () => {
  it('returns false when both hashes match', () => {
    expect(computePackageLockChanged('aaa', 'aaa')).toBe(false);
  });

  it('returns true when hashes differ', () => {
    expect(computePackageLockChanged('aaa', 'bbb')).toBe(true);
  });

  it('returns true when a lockfile is added (undefined → defined)', () => {
    // Previously `preHash && postHash && preHash !== postHash` was
    // false in this case, so `npm install` was skipped when a pull
    // introduced package-lock.json. Now it correctly surfaces the
    // change.
    expect(computePackageLockChanged(undefined, 'aaa')).toBe(true);
  });

  it('returns true when a lockfile is removed (defined → undefined)', () => {
    expect(computePackageLockChanged('aaa', undefined)).toBe(true);
  });

  it('returns false when neither pre nor post hash exists', () => {
    // Repo genuinely has no lockfile before and after — nothing to
    // install from, nothing to do.
    expect(computePackageLockChanged(undefined, undefined)).toBe(false);
  });
});

describe('installSourceUpdate', () => {
  beforeEach(() => vi.clearAllMocks());

  it('bails with failedStage=dirty-tree when working tree has uncommitted changes', () => {
    const root = makeFakeCheckout();
    const { runner, calls } = makeRunner({
      'git rev-parse --abbrev-ref HEAD': { stdout: 'main\n' },
      'git rev-parse HEAD': { stdout: 'aaaa111\n' },
      'git config --get remote.origin.url': { stdout: 'origin\n' },
      'git fetch --quiet origin': { stdout: '' },
      'git rev-parse origin/main': { stdout: 'bbbb222\n' },
      'git log --pretty=%s aaaa111..bbbb222': { stdout: 'fix: a\n' },
      'git status --porcelain': { stdout: ' M src/foo.ts\n' },
    });
    const result = installSourceUpdate(root, { runner });
    expect(result.ok).toBe(false);
    expect(result.failedStage).toBe('dirty-tree');
    expect(result.error).toContain('src/foo.ts');
    // No pull or npm call should have happened.
    expect(calls.find((c) => c.command === 'git' && c.args[0] === 'pull')).toBeUndefined();
    expect(calls.find((c) => c.command === 'npm')).toBeUndefined();
  });

  it('dry run returns ok without mutating anything', () => {
    const root = makeFakeCheckout();
    const { runner, calls } = makeRunner({
      'git rev-parse --abbrev-ref HEAD': { stdout: 'main\n' },
      'git rev-parse HEAD': { stdout: 'aaaa111\n' },
      'git config --get remote.origin.url': { stdout: 'origin\n' },
      'git fetch --quiet origin': { stdout: '' },
      'git rev-parse origin/main': { stdout: 'bbbb222\n' },
      'git log --pretty=%s aaaa111..bbbb222': { stdout: 'fix: a\n' },
      'git status --porcelain': { stdout: '' },
    });
    const result = installSourceUpdate(root, { runner, dryRun: true });
    expect(result.ok).toBe(true);
    expect(result.dryRun).toBe(true);
    expect(result.commitsPulled).toBe(1);
    expect(calls.find((c) => c.command === 'git' && c.args[0] === 'pull')).toBeUndefined();
  });

  it('returns ok without pulling when already up to date', () => {
    const root = makeFakeCheckout();
    const { runner } = makeRunner({
      'git rev-parse --abbrev-ref HEAD': { stdout: 'main\n' },
      'git rev-parse HEAD': { stdout: 'samecommit\n' },
      'git config --get remote.origin.url': { stdout: 'origin\n' },
      'git fetch --quiet origin': { stdout: '' },
      'git rev-parse origin/main': { stdout: 'samecommit\n' },
    });
    const result = installSourceUpdate(root, { runner });
    expect(result.ok).toBe(true);
    expect(result.commitsPulled).toBe(0);
    expect(result.installed).toBe(false);
    expect(result.built).toBe(false);
  });

  it('skips build when --skip-build and skips restart when --skip-restart', () => {
    const root = makeFakeCheckout();
    const { runner, calls } = makeRunner({
      'git rev-parse --abbrev-ref HEAD': { stdout: 'main\n' },
      'git rev-parse HEAD': { stdout: 'aaaa111\n' },
      'git config --get remote.origin.url': { stdout: 'origin\n' },
      'git fetch --quiet origin': { stdout: '' },
      'git rev-parse origin/main': { stdout: 'bbbb222\n' },
      'git log --pretty=%s aaaa111..bbbb222': { stdout: 'fix: a\n' },
      'git status --porcelain': { stdout: '' },
      'git pull --ff-only origin main': { stdout: 'fast-forward\n' },
    });
    const result = installSourceUpdate(root, { runner, skipBuild: true, skipRestart: true });
    expect(result.ok).toBe(true);
    expect(result.built).toBe(false);
    expect(result.serviceRestarted).toBe(false);
    expect(result.warnings).toContain('build skipped (--skip-build)');
    expect(result.warnings).toContain('service restart skipped (--skip-restart)');
    expect(calls.find((c) => c.command === 'npm' && c.args[0] === 'run')).toBeUndefined();
  });
});
