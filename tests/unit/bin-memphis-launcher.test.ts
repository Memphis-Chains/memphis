import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterAll, describe, expect, it } from 'vitest';

const thisDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(thisDir, '..', '..');
const launcherSource = readFileSync(path.join(repoRoot, 'bin', 'memphis.js'), 'utf8');
const tempDirs: string[] = [];

function createLauncherFixture(distEntrySource?: string): string {
  const fixtureDir = mkdtempSync(path.join(tmpdir(), 'memphis-launcher-fixture-'));
  tempDirs.push(fixtureDir);

  writeFileSync(path.join(fixtureDir, 'package.json'), JSON.stringify({ type: 'module' }, null, 2));
  mkdirSync(path.join(fixtureDir, 'bin'), { recursive: true });
  writeFileSync(path.join(fixtureDir, 'bin', 'memphis.js'), launcherSource);

  if (distEntrySource) {
    mkdirSync(path.join(fixtureDir, 'dist', 'infra', 'cli'), { recursive: true });
    writeFileSync(path.join(fixtureDir, 'dist', 'infra', 'cli', 'index.js'), distEntrySource);
  }

  return path.join(fixtureDir, 'bin', 'memphis.js');
}

afterAll(() => {
  for (const tempDir of tempDirs) {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

describe('bin/memphis.js', () => {
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
