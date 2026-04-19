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
});
