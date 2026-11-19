import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { expect, it } from 'vitest';

/**
 * The install of `onnxruntime-node` downloads the CUDA EP binaries from a
 * GitHub release. The release host stopped serving those assets, so every
 * `npm ci` in CI died with:
 *
 *   Failed to download the binaries: 404 Not Found.
 *   npm error code 1
 *
 * The repository therefore carries a `.npmrc` that sets
 * `onnxruntime-node-install-cuda=skip`. `onnxruntime-node`'s own install
 * script reads that value (`npm_config_onnxruntime_node_install_cuda`) and
 * skips the CUDA download. The CPU binaries ship inside the npm tarball, so
 * nothing the repository actually uses is lost.
 *
 * This contract fails when the flag stops reaching the install script — the
 * exact failure mode it prevents is invisible in a green build otherwise,
 * because the breakage only shows up on a runner that downloads the asset.
 */

const repoRoot = resolve(new URL('../..', import.meta.url).pathname);
const npmrcPath = join(repoRoot, '.npmrc');

function readNpmrc(): string {
  try {
    return readFileSync(npmrcPath, 'utf8');
  } catch {
    return '';
  }
}

it('carries the onnxruntime CUDA install skip in .npmrc', () => {
  const content = readNpmrc();
  expect(content, '`.npmrc` must exist in the repository root').not.toBe('');
  expect(content).toMatch(/^\s*onnxruntime-node-install-cuda\s*=\s*skip\s*$/m);
});

it('reaches the install script as npm_config_onnxruntime_node_install_cuda', () => {
  const root = mkdtempSync(join(tmpdir(), 'memphis-onnxruntime-skip-'));
  try {
    // A package whose install script prints the variable the real
    // `onnxruntime-node` script reads. The `.npmrc` is copied verbatim from
    // the repository, so this measures the real file, not a stand-in.
    writeFileSync(
      join(root, 'package.json'),
      JSON.stringify({
        name: 'onnxruntime-skip-probe',
        version: '1.0.0',
        scripts: {
          install:
            'node -e "console.log(\'PROBE=\' + JSON.stringify(process.env.npm_config_onnxruntime_node_install_cuda || null))"',
        },
      }),
    );
    writeFileSync(join(root, '.npmrc'), readNpmrc());

    const output = execFileSync('npm', ['run', 'install'], {
      cwd: root,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 60000,
    });
    expect(output).toContain('PROBE="skip"');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

it('is not ignored by git — otherwise the fix never reaches CI', () => {
  const listed = execFileSync('git', ['ls-files', '--error-unmatch', '.npmrc'], {
    cwd: repoRoot,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  expect(listed.trim()).toBe('.npmrc');
});
