import { spawnSync } from 'node:child_process';
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, describe, expect, it } from 'vitest';

const thisDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(thisDir, '..', '..');
const prettierBin = path.join(repoRoot, 'node_modules', '.bin', 'prettier');

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function makeTempRepo(): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'memphis-format-gate-'));
  tempDirs.push(dir);
  mkdirSync(path.join(dir, 'scripts'));
  copyFileSync(
    path.join(repoRoot, 'scripts', 'format-check-changed.sh'),
    path.join(dir, 'scripts', 'format-check-changed.sh'),
  );
  chmodSync(path.join(dir, 'scripts', 'format-check-changed.sh'), 0o755);
  run('git', ['init'], dir);
  run('git', ['config', 'user.email', 'test@example.test'], dir);
  run('git', ['config', 'user.name', 'Memphis Test'], dir);
  return dir;
}

function run(command: string, args: string[], cwd: string, env: Record<string, string> = {}) {
  const result = spawnSync(command, args, {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, ...env },
  });

  if (result.status !== 0) {
    throw new Error(
      `${command} ${args.join(' ')} failed with ${result.status}\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
    );
  }

  return result;
}

function gitCommitAll(cwd: string, message: string) {
  run('git', ['add', '.'], cwd);
  run('git', ['commit', '-m', message], cwd);
}

describe('format-check-changed.sh', () => {
  it('checks only files changed in the selected range', () => {
    const dir = makeTempRepo();
    writeFileSync(path.join(dir, 'legacy.js'), 'const legacy={a:1}\n');
    gitCommitAll(dir, 'legacy debt');

    writeFileSync(path.join(dir, 'changed.js'), 'const changed = { a: 1 };\n');
    gitCommitAll(dir, 'formatted change');

    const result = spawnSync('./scripts/format-check-changed.sh', [], {
      cwd: dir,
      encoding: 'utf8',
      env: { ...process.env, MEMPHIS_PRETTIER_BIN: prettierBin },
    });

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('1 changed tracked file');
    expect(result.stdout + result.stderr).not.toContain('legacy.js');
  });

  it('fails when a changed tracked file is not formatted', () => {
    const dir = makeTempRepo();
    writeFileSync(path.join(dir, 'legacy.js'), 'const legacy = { a: 1 };\n');
    gitCommitAll(dir, 'base');

    writeFileSync(path.join(dir, 'changed.js'), 'const changed={a:1}\n');
    gitCommitAll(dir, 'unformatted change');

    const result = spawnSync('./scripts/format-check-changed.sh', [], {
      cwd: dir,
      encoding: 'utf8',
      env: { ...process.env, MEMPHIS_PRETTIER_BIN: prettierBin },
    });

    expect(result.status).toBe(1);
    expect(result.stdout + result.stderr).toContain('changed.js');
  });

  it('passes when the selected range has no changed files to check', () => {
    const dir = makeTempRepo();
    writeFileSync(path.join(dir, 'tracked.js'), 'const tracked = { a: 1 };\n');
    gitCommitAll(dir, 'base');

    const head = run('git', ['rev-parse', 'HEAD'], dir).stdout.trim();
    const result = spawnSync('./scripts/format-check-changed.sh', [], {
      cwd: dir,
      encoding: 'utf8',
      env: {
        ...process.env,
        MEMPHIS_FORMAT_BASE_REF: head,
        MEMPHIS_FORMAT_HEAD_REF: head,
        MEMPHIS_PRETTIER_BIN: prettierBin,
      },
    });

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('[PASS] No changed tracked files');
  });
});

describe('nightly-crystal-pass.sh', () => {
  it('reports the real failing command exit code in JSON output', () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'memphis-nightly-exit-'));
    tempDirs.push(dir);
    mkdirSync(path.join(dir, 'scripts'));
    copyFileSync(
      path.join(repoRoot, 'scripts', 'nightly-crystal-pass.sh'),
      path.join(dir, 'scripts', 'nightly-crystal-pass.sh'),
    );
    chmodSync(path.join(dir, 'scripts', 'nightly-crystal-pass.sh'), 0o755);
    writeFileSync(
      path.join(dir, 'package.json'),
      JSON.stringify(
        {
          type: 'module',
          scripts: {
            'format:check:changed': 'node -e "process.exit(7)"',
            'format:changed': 'node -e "process.exit(0)"',
            lint: 'node -e "process.exit(0)"',
            typecheck: 'node -e "process.exit(0)"',
          },
        },
        null,
        2,
      ),
    );

    const result = spawnSync(
      './scripts/nightly-crystal-pass.sh',
      ['--json', '--skip-tests', '--skip-build', '--skip-bench', '--skip-security'],
      { cwd: dir, encoding: 'utf8', env: process.env },
    );

    expect(result.status).toBe(1);
    const parsed = JSON.parse(result.stdout) as {
      ok: boolean;
      results: Array<{ name: string; status: string; info?: string }>;
    };
    const formatCheck = parsed.results.find((entry) => entry.name === 'Format check');

    expect(parsed.ok).toBe(false);
    expect(formatCheck).toMatchObject({ status: 'FAIL', info: 'exit=7' });
  });
});
