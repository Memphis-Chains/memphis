import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { ModuleKind, ScriptTarget, transpileModule } from 'typescript';
import { afterAll, describe, expect, it } from 'vitest';

const thisDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(thisDir, '..', '..');
const launcherSource = readFileSync(path.join(repoRoot, 'bin', 'memphis.js'), 'utf8');
const tempDirs: string[] = [];

function createLauncherFixture(distEntrySource?: string, options?: { withRemedy?: boolean }): string {
  const fixtureDir = mkdtempSync(path.join(tmpdir(), 'memphis-launcher-fixture-'));
  tempDirs.push(fixtureDir);

  writeFileSync(path.join(fixtureDir, 'package.json'), JSON.stringify({ type: 'module' }, null, 2));
  mkdirSync(path.join(fixtureDir, 'bin'), { recursive: true });
  writeFileSync(path.join(fixtureDir, 'bin', 'memphis.js'), launcherSource);

  // The launcher loads the remedy module lazily, from its own directory.
  // It is carried into the fixture ONLY when a test asks for it: the
  // default fixture runs WITHOUT it, which is the proof that a missing
  // module cannot change the exit code systemd's RestartPreventExitStatus
  // reads.
  if (options?.withRemedy) {
    const remedySource = path.join(repoRoot, 'bin', 'install-remedy.mjs');
    writeFileSync(path.join(fixtureDir, 'bin', 'install-remedy.mjs'), readFileSync(remedySource, 'utf8'));
  }

  if (distEntrySource) {
    mkdirSync(path.join(fixtureDir, 'dist', 'infra', 'cli'), { recursive: true });
    writeFileSync(path.join(fixtureDir, 'dist', 'infra', 'cli', 'index.js'), distEntrySource);
    mkdirSync(path.join(fixtureDir, 'dist', 'infra', 'runtime'), { recursive: true });
    const exitCodes = transpileModule(
      readFileSync(path.join(repoRoot, 'src', 'infra', 'runtime', 'exit-codes.ts'), 'utf8'),
      { compilerOptions: { module: ModuleKind.ESNext, target: ScriptTarget.ES2022 } },
    );
    writeFileSync(
      path.join(fixtureDir, 'dist', 'infra', 'runtime', 'exit-codes.js'),
      exitCodes.outputText,
    );
  }

  return path.join(fixtureDir, 'bin', 'memphis.js');
}

afterAll(() => {
  for (const tempDir of tempDirs) {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

describe('bin/memphis.js', () => {
  it.each([101, 102, 103])('preserves permanent startup exit code %s', (exitCode) => {
    const launcherPath = createLauncherFixture(`
      import { MemphisExitError } from '../runtime/exit-codes.js';
      export async function runCli() { throw new MemphisExitError(${exitCode}, 'synthetic startup failure'); }
    `);
    const result = spawnSync(process.execPath, [launcherPath, 'serve'], {
      env: { ...process.env, MEMPHIS_DATA_DIR: path.join(path.dirname(launcherPath), 'data') },
      encoding: 'utf8',
      timeout: 10000,
    });
    expect(result.status).toBe(exitCode);
    expect(result.stderr).toContain('synthetic startup failure');
  });

  it('names the npm 12 remedy when the native binding is missing', () => {
    // Measured 2026-11-24 on the operator's host against the PUBLISHED
    // v1.14.1 tarball: the install exited 0 and every command died with
    // "Could not locate the bindings file" and thirteen candidate paths.
    // The remedy is the sentence that says what npm 12 did and what one
    // line fixes.
    const launcherPath = createLauncherFixture(
      "throw new Error('Could not locate the bindings file. Tried:\\n → /x/better-sqlite3/build/Release/better_sqlite3.node');",
      { withRemedy: true },
    );

    const result = spawnSync(process.execPath, [launcherPath, 'health'], {
      encoding: 'utf8',
      timeout: 10000,
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('allowScripts');
    expect(result.stderr).toContain('better-sqlite3');
  });

  it('keeps unexpected import failures on the general error code', () => {
    const launcherPath = createLauncherFixture("throw new Error('synthetic import failure');");
    const result = spawnSync(process.execPath, [launcherPath, 'health'], {
      encoding: 'utf8',
      timeout: 10000,
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('synthetic import failure');
  });

  it('loads the compiled dist entrypoint when present', () => {
    const launcherPath = createLauncherFixture(
      'export async function runCli(argv) { process.stdout.write(JSON.stringify({ argv })); }',
    );

    const result = spawnSync('node', [launcherPath, 'health', '--json'], {
      encoding: 'utf8',
      timeout: 120_000,
    });

    expect(result.status).toBe(0);
    expect(result.stderr).toBe('');
    expect(JSON.parse(result.stdout) as { argv: string[] }).toEqual({
      argv: expect.arrayContaining(['health', '--json']),
    });
  });

  it('fails closed with a build-missing error when dist is absent', () => {
    const launcherPath = createLauncherFixture();

    const result = spawnSync('node', [launcherPath, 'health'], {
      encoding: 'utf8',
      timeout: 120_000,
    });

    expect(result.status).toBe(1);
    expect(result.stdout).toBe('');
    expect(result.stderr).toContain('Memphis CLI build is missing.');
    expect(result.stderr).toContain('dist/infra/cli/index.js');
    expect(result.stderr).toContain('npm run build');
    expect(result.stderr).not.toContain('src/infra/cli/index.ts');
  });
});
