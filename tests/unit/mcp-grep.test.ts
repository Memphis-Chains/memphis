import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { buildGrepArgs, buildRipgrepArgs, runMemphisGrep } from '../../src/mcp/tools/grep.js';

interface TestEnv {
  tmpHome: string;
  sandboxDir: string;
  origHome: string | undefined;
}

function setup(): TestEnv {
  const tmpHome = mkdtempSync(path.join(os.tmpdir(), 'memphis-grep-'));
  const sandboxDir = path.join(tmpHome, 'memphis');
  mkdirSync(path.join(sandboxDir, 'src'), { recursive: true });
  mkdirSync(path.join(sandboxDir, 'dist'), { recursive: true });
  const origHome = process.env.HOME;
  process.env.HOME = tmpHome;
  return { tmpHome, sandboxDir, origHome };
}

function tearDown(env: TestEnv): void {
  if (env.origHome === undefined) delete process.env.HOME;
  else process.env.HOME = env.origHome;
  rmSync(env.tmpHome, { recursive: true, force: true });
}

describe('mcp grep', () => {
  let env: TestEnv;

  beforeEach(() => {
    env = setup();
  });

  afterEach(() => {
    tearDown(env);
  });

  it('searches relative project paths and excludes generated dirs by default', () => {
    writeFileSync(path.join(env.sandboxDir, 'src', 'live.ts'), 'const needle = 1;\n', 'utf8');
    writeFileSync(path.join(env.sandboxDir, 'dist', 'generated.js'), 'const needle = 2;\n', 'utf8');

    const result = runMemphisGrep({ pattern: 'needle', path: 'src' });

    expect(result.error).toBeUndefined();
    expect(result.matches).toContain('src/live.ts');
    expect(result.matches).not.toContain('dist/generated.js');
  });

  it('searches a directory anywhere on the host, because the host is readable', () => {
    const outsideDir = mkdtempSync(path.join(os.tmpdir(), 'memphis-grep-host-wide-'));
    try {
      const target = path.join(outsideDir, 'deep');
      mkdirSync(target, { recursive: true });
      writeFileSync(path.join(target, 'payload.ts'), 'const needle = 3;\n', 'utf8');

      const result = runMemphisGrep({ pattern: 'needle', path: target });

      expect(result.error).toBeUndefined();
      expect(result.matches).toContain('payload.ts');
    } finally {
      rmSync(outsideDir, { recursive: true, force: true });
    }
  });

  it('refuses to search vault material, because the output is indexed', () => {
    const vaultDir = path.join(env.tmpHome, 'vault-probe');
    mkdirSync(vaultDir, { recursive: true });
    const envFile = path.join(vaultDir, '.env');
    writeFileSync(envFile, 'SECRET=needle\n', 'utf8');

    // The path that NAMES vault material is refused outright.
    expect(() => runMemphisGrep({ pattern: 'needle', path: envFile })).toThrow(/blocked/i);
  });

  it('does not return the contents of a vault-material file inside a searched directory', () => {
    const vaultDir = path.join(env.tmpHome, 'vault-probe-dir');
    mkdirSync(vaultDir, { recursive: true });
    writeFileSync(path.join(vaultDir, '.env'), 'SECRET=needle\n', 'utf8');
    writeFileSync(path.join(vaultDir, '.env.production'), 'SECRET2=needle\n', 'utf8');
    writeFileSync(path.join(vaultDir, 'vault-state.json'), '{"k":"needle"}\n', 'utf8');
    writeFileSync(path.join(vaultDir, 'vault-entries.json'), '{"k":"needle"}\n', 'utf8');
    writeFileSync(path.join(vaultDir, 'ordinary.ts'), 'const needle = 5;\n', 'utf8');

    const result = runMemphisGrep({ pattern: 'needle', path: vaultDir });

    expect(result.error).toBeUndefined();
    expect(result.matches).toContain('ordinary.ts');
    expect(result.matches).not.toContain('SECRET');
    expect(result.matches).not.toContain('SECRET2');
    expect(result.matches).not.toContain('.env');
    expect(result.matches).not.toContain('vault-state.json');
    expect(result.matches).not.toContain('vault-entries.json');
  });

  it('excludes vault material from the ripgrep invocation', () => {
    // The argument builder is a pure function, so this rule is tested even
    // on a host where ripgrep is not installed — which is the case here,
    // and the reason the exclusion had no test at all.
    const args = buildRipgrepArgs({
      pattern: 'needle',
      searchPath: '/tmp/probe',
      limit: 50,
      context: 0,
      ignoreCase: false,
    });
    expect(args).toContain('--glob=!.env');
    expect(args).toContain('--glob=!.env.*');
    expect(args).toContain('--glob=!vault-state.json');
    expect(args).toContain('--glob=!vault-entries.json');
  });

  it('excludes vault material from the GNU grep fallback', () => {
    const args = buildGrepArgs({
      pattern: 'needle',
      searchPath: '/tmp/probe',
      limit: 50,
      context: 0,
      ignoreCase: false,
    });
    // `.env*`, not `.env`: `--exclude` matches the file name against a
    // glob, so `--exclude=.env` would leave `.env.production` in.
    expect(args).toContain('--exclude=.env*');
    expect(args).toContain('--exclude=vault-state.json');
    expect(args).toContain('--exclude=vault-entries.json');
  });

  it('narrows back down when MEMPHIS_CODE_READ_ROOTS is set', () => {
    const outsideDir = mkdtempSync(path.join(os.tmpdir(), 'memphis-grep-narrowed-'));
    const prevRoots = process.env.MEMPHIS_CODE_READ_ROOTS;
    try {
      writeFileSync(path.join(outsideDir, 'payload.ts'), 'const needle = 4;\n', 'utf8');
      process.env.MEMPHIS_CODE_READ_ROOTS = env.sandboxDir;

      expect(() => runMemphisGrep({ pattern: 'needle', path: outsideDir })).toThrow(
        /outside the allowed read roots/i,
      );
    } finally {
      if (prevRoots === undefined) delete process.env.MEMPHIS_CODE_READ_ROOTS;
      else process.env.MEMPHIS_CODE_READ_ROOTS = prevRoots;
      rmSync(outsideDir, { recursive: true, force: true });
    }
  });
});
