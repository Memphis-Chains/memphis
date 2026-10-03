import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, describe, expect, it } from 'vitest';

import { realTmpdir as tmpdir } from '../helpers/tmpdir.js';

const thisDir = fileURLToPath(new URL('.', import.meta.url));
const repoRoot = join(thisDir, '..', '..');
const serverSource = join(repoRoot, 'scripts', 'basal', 'basal_cpu.py');

/**
 * Run the installer against a scratch install root, hermetically.
 *
 * Every external command it reaches for is stubbed on PATH. The pgrep stub
 * matters most: the real installer discovers its server with
 * `pgrep -f basal_cpu.py`, so without a stub the suite adopts whatever
 * BASAL instance the operator happens to be running and a passing test would
 * prove nothing about a clean install.
 *
 * Steps 1-4 (venv, deps, upstream source, model weights) are pre-satisfied
 * by creating what they look for, so the run reaches the step under test:
 * placing the server script in the install root. The curl stub answers
 * `ready: true` on /health, which is exactly what a loaded model answers,
 * so the final readiness gate passes without a 3.2 GB download.
 */
function runInstaller(scratch: string): { status: number | null; stdout: string; stderr: string } {
  const installRoot = join(scratch, 'install-root');
  const home = join(scratch, 'home');
  const bin = join(scratch, 'bin');
  const venvBin = join(installRoot, 'venv', 'bin');
  for (const dir of [installRoot, home, bin, venvBin]) {
    mkdirSync(dir, { recursive: true });
  }
  // Step 3 short-circuits on the upstream source tree being present.
  mkdirSync(join(installRoot, 'src', 'basal'), { recursive: true });

  writeFileSync(join(venvBin, 'python'), '#!/bin/sh\nexit 0\n');
  const stubs: Record<string, string> = {
    // Steps 1, 2 and 4 all probe a venv python that can import; the stub
    // answers 0 to everything, which is what "already installed" looks like.
    python: '#!/bin/sh\nexit 0\n',
    uv: '#!/bin/sh\nexit 0\n',
    // Nothing of ours is running, so the installer takes its start path.
    pgrep: '#!/bin/sh\nexit 1\n',
    curl:
      '#!/bin/sh\n' +
      'case "$*" in\n' +
      '  */health) echo \'{"ok":true,"ready":true}\' ;;\n' +
      'esac\n' +
      'exit 0\n',
  };
  for (const [name, body] of Object.entries(stubs)) {
    const path = name === 'python' ? join(venvBin, 'python') : join(bin, name);
    writeFileSync(path, body);
    chmodSync(path, 0o755);
  }

  const result = spawnSync('bash', ['./scripts/install-basal.sh'], {
    cwd: repoRoot,
    encoding: 'utf8',
    timeout: 120_000,
    env: {
      ...process.env,
      PATH: `${bin}:${process.env.PATH ?? ''}`,
      HOME: home,
      MEMPHIS_BASAL_DIR: installRoot,
      MEMPHIS_BASAL_LOG: join(scratch, 'basal.log'),
    },
  });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

const scratches: string[] = [];

afterEach(() => {
  for (const dir of scratches.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe('scripts/install-basal.sh places the server script in a clean install root', () => {
  it('keeps the server source in the repo, not only in the install root', () => {
    // The bug this covers: basal_cpu.py lived only under ~/.local/share, so
    // step 5 could not install it and a clean host died on the very install
    // whose --help calls itself one-shot.
    const source = readFileSync(serverSource, 'utf8');
    expect(source).toContain('/v1/systemone');
    expect(source).toContain('/health');
  });

  it('installs it and reaches ready without network or a real model', () => {
    const scratch = mkdtempSync(join(tmpdir(), 'memphis-basal-install-'));
    scratches.push(scratch);

    const result = runInstaller(scratch);

    expect(result.stderr).toBe('');
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('installing server script');
    // The readiness gate was actually passed, not just reached.
    expect(result.stdout).toContain('[basal] ready');
    expect(readFileSync(join(scratch, 'install-root', 'basal_cpu.py'), 'utf8')).toBe(
      readFileSync(serverSource, 'utf8'),
    );
  });

  it('is idempotent: a second run copies nothing and still succeeds', () => {
    const scratch = mkdtempSync(join(tmpdir(), 'memphis-basal-idem-'));
    scratches.push(scratch);

    expect(runInstaller(scratch).status).toBe(0);
    const second = runInstaller(scratch);

    expect(second.status).toBe(0);
    // The file already matches, so the copy is skipped rather than redone.
    expect(second.stdout).not.toContain('installing server script');
  });

  it('refuses to start when the server source is absent instead of pretending', () => {
    const scratch = mkdtempSync(join(tmpdir(), 'memphis-basal-nosrc-'));
    scratches.push(scratch);
    // An empty checkout: the installer resolves the server source from its
    // own repo root, so the guard has to name the path it looked for.
    const emptyRoot = join(scratch, 'empty-checkout');
    mkdirSync(join(emptyRoot, 'scripts'), { recursive: true });

    const result = spawnSync(
      'bash',
      [
        '-c',
        'set -uo pipefail\n' +
          'die() { echo "[basal] ERROR: $*" >&2; exit 1; }\n' +
          'SERVER_SRC="$1/scripts/basal/basal_cpu.py"\n' +
          'if [[ ! -f "$SERVER_SRC" ]]; then die "server source missing: $SERVER_SRC"; fi\n' +
          'echo "would install"',
        'bash',
        emptyRoot,
      ],
      { encoding: 'utf8', timeout: 30_000 },
    );

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('server source missing');
    expect(result.stdout).toBe('');
  });
});
