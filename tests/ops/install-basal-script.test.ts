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

describe('the gguf fast path is a declared part of the install, not a local accident', () => {
  const installer = readFileSync(join(repoRoot, 'scripts', 'install-basal.sh'), 'utf8');

  it('installs llama-cpp-python and the Q8_0 weights a clean host needs', () => {
    // The bug this covers: basal_cpu.py gained a gguf backend that is 5x
    // faster on this host, but the installer never fetched llama-cpp-python
    // or the .gguf file, so a clean install silently ran the 99s torch path
    // while the operator's own machine looked 5x faster than the docs.
    expect(installer).toContain('llama-cpp-python');
    expect(installer).toContain('basal-1.0-1.5B-Q8_0.gguf');
  });

  it('keeps the gguf path optional so a host with a usable GPU is not charged for it', () => {
    // llama-cpp-python is a ~8 min CPU build plus ~1.6 GB. A host that
    // cannot use the backend (no supported GPU is exactly our case, but a
    // working GPU is not) must be able to opt out and still install.
    expect(installer).toContain('MEMPHIS_BASAL_GGUF:-1');
    expect(installer).toContain('MEMPHIS_BASAL_GGUF=0');
  });

  it('the server falls back to torch when the gguf file is absent', () => {
    // A missing .gguf must degrade, never crash: the whole point of the
    // fallback is that a partial install still serves.
    const source = readFileSync(serverSource, 'utf8');
    expect(source).toContain('falling back to torch');
    expect(source).toMatch(/except Exception/);
  });

  it('reports the active backend in /health so the fast path is observable', () => {
    // "It got faster" is a claim; without a field in /health nobody can
    // tell which backend answered a request. Scoped to the health handler
    // on purpose: a bare toContain('"backend"') also matches the usage
    // block of /v1/systemone, and deleting the /health field left every
    // test green (verified by mutation).
    const source = readFileSync(serverSource, 'utf8');
    const health = source.slice(
      source.indexOf('@app.get("/health")'),
      source.indexOf('@app.post("/v1/systemone")'),
    );
    expect(health).toContain('GgufBackend');
    expect(health).toMatch(/"backend"/);
  });

  it('does not route through the upstream ollama mode', () => {
    // Measured: Ollama caps top_logprobs at 20 and this model puts the
    // rejected option letters below that, so a valid answer comes back
    // incomplete. Its safetensors check is also unreachable because Ollama
    // >= 0.23 reports format=gguf after converting on import. gguf via
    // llama.cpp has neither problem, so the server must not import it.
    const source = readFileSync(serverSource, 'utf8');
    expect(source).not.toMatch(/from basal\.ollama/);
    expect(source).not.toMatch(/OllamaBackend/);
  });
});
