import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { validateFilePath } from '../../src/mcp/tools/self-modify.js';

/**
 * Regression net for #136: self-modify's validateFilePath used path.resolve
 * only (pure string manipulation — doesn't follow symlinks), so a symlink
 * inside the project root pointing at an outside target passed validation,
 * and the subsequent writeFileSync happily followed the link. Fix reuses
 * realpathOrNearest from fs-permission.ts to resolve symlinks before the
 * prefix check.
 */

interface Env {
  tmpRoot: string;
  outsideDir: string;
}

function setup(): Env {
  const tmpRoot = mkdtempSync(path.join(os.tmpdir(), 'memphis-selfmod-'));
  const outsideDir = mkdtempSync(path.join(os.tmpdir(), 'memphis-selfmod-outside-'));
  mkdirSync(path.join(tmpRoot, 'src'), { recursive: true });
  return { tmpRoot, outsideDir };
}

function tearDown(env: Env): void {
  rmSync(env.tmpRoot, { recursive: true, force: true });
  rmSync(env.outsideDir, { recursive: true, force: true });
}

describe('self-modify — validateFilePath', () => {
  let env: Env;

  beforeEach(() => {
    env = setup();
  });

  afterEach(() => {
    tearDown(env);
  });

  it('accepts a normal path inside project root', () => {
    const out = validateFilePath('src/app.ts', env.tmpRoot);
    expect(out).toBe(path.join(env.tmpRoot, 'src', 'app.ts'));
  });

  it('rejects a dotfile at the root (.env)', () => {
    expect(() => validateFilePath('.env', env.tmpRoot)).toThrow(/Dotfile/);
  });

  it('rejects paths containing .git/', () => {
    expect(() => validateFilePath('.git/HEAD', env.tmpRoot)).toThrow();
  });

  it('rejects path traversal out of project root', () => {
    expect(() => validateFilePath('../escape.ts', env.tmpRoot)).toThrow(/Path traversal/);
  });

  it('rejects a symlink inside the root whose target is outside (#136)', () => {
    const outsideTarget = path.join(env.outsideDir, 'evil.ts');
    writeFileSync(outsideTarget, 'malicious', 'utf8');

    const linkInsideRoot = path.join(env.tmpRoot, 'src', 'sneaky.ts');
    symlinkSync(outsideTarget, linkInsideRoot);

    expect(() => validateFilePath('src/sneaky.ts', env.tmpRoot)).toThrow(/Path traversal/);
  });

  it('rejects a symlinked directory inside root pointing outside (#136)', () => {
    const linkDir = path.join(env.tmpRoot, 'src', 'linked');
    symlinkSync(env.outsideDir, linkDir);

    expect(() => validateFilePath('src/linked/payload.ts', env.tmpRoot)).toThrow(/Path traversal/);
  });
});
