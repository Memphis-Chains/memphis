import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { nativeBindingRemedy } from '../../bin/install-remedy.mjs';

const thisDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(thisDir, '..', '..');

function read(relativePath: string): string {
  return readFileSync(path.join(repoRoot, relativePath), 'utf8');
}

/**
 * The install contract.
 *
 * Measured 2026-11-24 on this host, against the PUBLISHED v1.14.1 tarball
 * installed into a clean prefix with npm 12.0.2:
 *
 *  - npm 12 blocks dependency install scripts by default and reads
 *    `allowScripts` from the PROJECT ROOT — the installed
 *    `node_modules/@memphis-chains/memphis/package.json` carried
 *    `{"better-sqlite3": true, ...}` and the script was blocked anyway;
 *  - `better-sqlite3` ships no prebuilt binding, so the CLI died on every
 *    command with "Could not locate the bindings file";
 *  - the release gate passed 11/11 anyway: it installed with
 *    `--ignore-scripts` and probed only `--help` and `completion bash`,
 *    neither of which opens the journal database.
 *
 * These assertions pin the three things that make that failure impossible
 * to repeat silently: the gate installs under a declared policy, the gate
 * probes a command that opens the database, and the CLI names the remedy
 * when the binding is missing.
 */
describe('package install contract', () => {
  it('installs the artifact under a declared policy instead of --ignore-scripts', () => {
    const gate = read('scripts/validate-package-artifact.mts');

    // The hole: `--ignore-scripts` guarantees that no native binding is
    // built, and the old probes never noticed.
    expect(gate).not.toContain("'--ignore-scripts'");

    // The policy the gate installs under, and the approval it declares.
    expect(gate).toContain('CONSUMER_ALLOW_SCRIPTS');
    expect(gate).toContain("'better-sqlite3': true");
    expect(gate).toContain('allowScripts');
    expect(gate).toContain('npm_config_onnxruntime_node_install_cuda');

    // The assertion that the install produced what the CLI needs.
    expect(gate).toContain('better_sqlite3.node');
    expect(gate).toContain('resolveNativeBinding');
  });

  it('probes a command that opens the journal database', () => {
    const gate = read('scripts/validate-package-artifact.mts');

    // `--help` and `completion bash` never touch the database, so they
    // cannot tell a working package from a dead one.
    expect(gate).toContain("args: ['vault', 'list', '--json']");
  });

  it('names the remedy when the native binding is missing', () => {
    const remedy = nativeBindingRemedy(
      'Could not locate the bindings file. Tried:\n → /x/better-sqlite3/build/Release/better_sqlite3.node',
    );

    expect(remedy).not.toBeNull();
    const text = (remedy ?? []).join('\n');
    expect(text).toContain('allowScripts');
    expect(text).toContain('better-sqlite3');
    expect(text).toContain('npm 12');
  });

  it('stays silent for failures that are not a missing native binding', () => {
    expect(nativeBindingRemedy('Cannot find module \'./dist/infra/cli/index.js\'')).toBeNull();
    expect(nativeBindingRemedy('')).toBeNull();
  });

  it('documents the npm 12 install rule for the operator', () => {
    const readme = read('README.md');

    expect(readme).toContain('Installing on npm 12 and newer');
    expect(readme).toContain('"allowScripts": { "better-sqlite3": true }');
    // Approving onnxruntime-node breaks the install: its script downloads a
    // CUDA build that answers 404, and the CPU runtime ships in the package.
    expect(readme).toContain('onnxruntime-node');
  });

  it('keeps the repository\'s own install policy covering better-sqlite3', () => {
    const pkg = JSON.parse(read('package.json')) as {
      allowScripts?: Record<string, boolean>;
    };

    expect(pkg.allowScripts?.['better-sqlite3']).toBe(true);
  });
});
