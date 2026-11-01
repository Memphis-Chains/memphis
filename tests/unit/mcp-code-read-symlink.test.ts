import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { runMemphisCodeRead } from '../../src/mcp/tools/code-read.js';

/**
 * The read scope of `memphis_code_read`.
 *
 * The scope is the TIER (2, vault passphrase), not a whitelist of
 * directories: `memphis_exec` at the same tier could `cat` any file on the
 * host, so the old directory whitelist protected nothing — it only made the
 * tool refuse work the operator asked for ("Memphis must be able to read
 * everything on this computer").
 *
 * What is still refused is vault material, because this tool's output is
 * indexed: it lands in the journal and in the semantic embed index, i.e. a
 * plaintext copy of a secret outside the encrypted vault.
 */

interface TestEnv {
  tmpHome: string;
  sandboxDir: string;
  origHome: string | undefined;
}

function setup(): TestEnv {
  const tmpHome = mkdtempSync(path.join(os.tmpdir(), 'memphis-code-read-'));
  const sandboxDir = path.join(tmpHome, 'memphis');
  mkdirSync(sandboxDir, { recursive: true });
  const origHome = process.env.HOME;
  process.env.HOME = tmpHome;
  return { tmpHome, sandboxDir, origHome };
}

function tearDown(env: TestEnv): void {
  if (env.origHome === undefined) delete process.env.HOME;
  else process.env.HOME = env.origHome;
  rmSync(env.tmpHome, { recursive: true, force: true });
}

describe('mcp code-read — the read scope is the tier, not a directory whitelist', () => {
  let env: TestEnv;

  beforeEach(() => {
    env = setup();
  });

  afterEach(() => {
    tearDown(env);
  });

  it('reads a regular file inside the sandbox', () => {
    const target = path.join(env.sandboxDir, 'legit.ts');
    writeFileSync(target, 'export const x = 1;\n', 'utf8');
    const result = runMemphisCodeRead({ path: target });
    expect(result.error).toBeUndefined();
    expect(result.content).toContain('export const x = 1');
  });

  it('resolves relative paths against ~/memphis instead of process cwd', () => {
    const targetDir = path.join(env.sandboxDir, 'src');
    mkdirSync(targetDir, { recursive: true });
    writeFileSync(path.join(targetDir, 'relative.ts'), 'export const rel = true;\n', 'utf8');

    const result = runMemphisCodeRead({ path: 'src/relative.ts' });

    expect(result.error).toBeUndefined();
    expect(result.path).toBe(path.join(env.sandboxDir, 'src', 'relative.ts'));
    expect(result.content).toContain('export const rel = true');
  });

  it('reads through a symlink pointing outside ~/memphis, because the host is readable', () => {
    const outsideDir = mkdtempSync(path.join(os.tmpdir(), 'memphis-escape-'));
    try {
      const secretFile = path.join(outsideDir, 'secret.txt');
      writeFileSync(secretFile, 'SENSITIVE', 'utf8');

      const linkPath = path.join(env.sandboxDir, 'escape.ts');
      symlinkSync(secretFile, linkPath);

      const result = runMemphisCodeRead({ path: linkPath });
      expect(result.error).toBeUndefined();
      expect(result.content).toContain('SENSITIVE');
    } finally {
      rmSync(outsideDir, { recursive: true, force: true });
    }
  });

  it('reads a file anywhere on the host, not only inside ~/memphis', () => {
    const outsideDir = mkdtempSync(path.join(os.tmpdir(), 'memphis-host-wide-'));
    try {
      const target = path.join(outsideDir, 'deep', 'payload.txt');
      mkdirSync(path.dirname(target), { recursive: true });
      writeFileSync(target, 'host wide\n', 'utf8');

      const result = runMemphisCodeRead({ path: target });
      expect(result.error).toBeUndefined();
      expect(result.content).toContain('host wide');
    } finally {
      rmSync(outsideDir, { recursive: true, force: true });
    }
  });

  it('narrows back down when MEMPHIS_CODE_READ_ROOTS is set', () => {
    const outsideDir = mkdtempSync(path.join(os.tmpdir(), 'memphis-narrowed-'));
    const prevRoots = process.env.MEMPHIS_CODE_READ_ROOTS;
    try {
      const target = path.join(outsideDir, 'payload.txt');
      writeFileSync(target, 'narrowed\n', 'utf8');
      process.env.MEMPHIS_CODE_READ_ROOTS = env.sandboxDir;

      expect(() => runMemphisCodeRead({ path: target })).toThrow(/outside the allowed read roots/i);

      // Inside the configured root, the read still works.
      const inside = path.join(env.sandboxDir, 'inside.ts');
      writeFileSync(inside, 'inside\n', 'utf8');
      expect(runMemphisCodeRead({ path: inside }).content).toContain('inside');
    } finally {
      if (prevRoots === undefined) delete process.env.MEMPHIS_CODE_READ_ROOTS;
      else process.env.MEMPHIS_CODE_READ_ROOTS = prevRoots;
      rmSync(outsideDir, { recursive: true, force: true });
    }
  });

  it('reads Memphis operator data and project files outside ~/memphis', () => {
    const dataDir = path.join(env.tmpHome, '.memphis', 'apps', 'lr-dashboard');
    const projectDir = path.join(env.tmpHome, 'projects', 'lr-dashboard');
    mkdirSync(dataDir, { recursive: true });
    mkdirSync(projectDir, { recursive: true });
    writeFileSync(path.join(dataDir, 'manifest.json'), '{"name":"lr-dashboard"}\n', 'utf8');
    writeFileSync(path.join(projectDir, 'package.json'), '{"name":"lr-dashboard"}\n', 'utf8');

    const dataResult = runMemphisCodeRead({ path: path.join(dataDir, 'manifest.json') });
    const projectResult = runMemphisCodeRead({ path: path.join(projectDir, 'package.json') });

    expect(dataResult.error).toBeUndefined();
    expect(dataResult.content).toContain('lr-dashboard');
    expect(projectResult.error).toBeUndefined();
    expect(projectResult.content).toContain('lr-dashboard');
  });

  it('still refuses secret-shaped files in newly allowed roots', () => {
    const dataDir = path.join(env.tmpHome, '.memphis', 'apps', 'lr-dashboard');
    mkdirSync(dataDir, { recursive: true });
    const envPath = path.join(dataDir, '.env');
    writeFileSync(envPath, 'SECRET=value\n', 'utf8');

    expect(() => runMemphisCodeRead({ path: envPath })).toThrow(/blocked/i);
  });

  it('refuses vault material wherever it lives, because the output is indexed', () => {
    const cases = ['.env', '.env.production', 'vault-state.json', 'vault-entries.json'];
    for (const name of cases) {
      const target = path.join(env.tmpHome, 'somewhere', name);
      mkdirSync(path.dirname(target), { recursive: true });
      writeFileSync(target, 'SECRET=1\n', 'utf8');
      expect(() => runMemphisCodeRead({ path: target }), name).toThrow(/blocked/i);
    }
  });

  it('reads a file inside node_modules — generated state, not a secret', () => {
    const target = path.join(env.sandboxDir, 'node_modules', 'pkg', 'index.js');
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, 'module.exports = 1;\n', 'utf8');

    const result = runMemphisCodeRead({ path: target });
    expect(result.error).toBeUndefined();
    expect(result.content).toContain('module.exports');
  });
});
