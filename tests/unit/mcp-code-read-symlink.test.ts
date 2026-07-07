import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { runMemphisCodeRead } from '../../src/mcp/tools/code-read.js';

/**
 * Regression net for #132: memphis_code_read used path.normalize-only for
 * its sandbox check, so a symlink inside ~/memphis pointing at /etc (or any
 * outside path) passed validation and readFileSync followed it. The fix
 * reuses isInsideMemphisSandbox from fs-permission.ts, which realpaths.
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

describe('mcp code-read — symlink escape protection (#132)', () => {
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

  it('refuses to read through a symlink pointing outside the sandbox', () => {
    const outsideDir = mkdtempSync(path.join(os.tmpdir(), 'memphis-escape-'));
    try {
      const secretFile = path.join(outsideDir, 'secret.txt');
      writeFileSync(secretFile, 'SENSITIVE', 'utf8');

      const linkPath = path.join(env.sandboxDir, 'escape.ts');
      symlinkSync(secretFile, linkPath);

      expect(() => runMemphisCodeRead({ path: linkPath })).toThrow(/outside the allowed/i);
    } finally {
      rmSync(outsideDir, { recursive: true, force: true });
    }
  });

  it('refuses to descend through a symlink-directory to an outside file', () => {
    const outsideDir = mkdtempSync(path.join(os.tmpdir(), 'memphis-escape-dir-'));
    try {
      const inner = path.join(outsideDir, 'payload.txt');
      writeFileSync(inner, 'SENSITIVE', 'utf8');

      const linkDir = path.join(env.sandboxDir, 'esc-dir');
      symlinkSync(outsideDir, linkDir);

      expect(() => runMemphisCodeRead({ path: path.join(linkDir, 'payload.txt') })).toThrow(
        /outside the allowed/i,
      );
    } finally {
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
});
