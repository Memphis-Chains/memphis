import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { runMemphisGrep } from '../../src/mcp/tools/grep.js';

interface TestEnv {
  tmpHome: string;
  sandboxDir: string;
  origHome: string | undefined;
}

function setup(): TestEnv {
  const tmpHome = mkdtempSync(path.join(os.tmpdir(), 'memphis-grep-'));
  const sandboxDir = path.join(tmpHome, 'memphis');
  mkdirSync(path.join(sandboxDir, 'src'), { recursive: true });
  mkdirSync(path.join(sandboxDir, 'dist'), { recursive: true });
  const origHome = process.env.HOME;
  process.env.HOME = tmpHome;
  return { tmpHome, sandboxDir, origHome };
}

function tearDown(env: TestEnv): void {
  if (env.origHome === undefined) delete process.env.HOME;
  else process.env.HOME = env.origHome;
  rmSync(env.tmpHome, { recursive: true, force: true });
}

describe('mcp grep', () => {
  let env: TestEnv;

  beforeEach(() => {
    env = setup();
  });

  afterEach(() => {
    tearDown(env);
  });

  it('searches relative project paths and excludes generated dirs by default', () => {
    writeFileSync(path.join(env.sandboxDir, 'src', 'live.ts'), 'const needle = 1;\n', 'utf8');
    writeFileSync(path.join(env.sandboxDir, 'dist', 'generated.js'), 'const needle = 2;\n', 'utf8');

    const result = runMemphisGrep({ pattern: 'needle', path: 'src' });

    expect(result.error).toBeUndefined();
    expect(result.matches).toContain('src/live.ts');
    expect(result.matches).not.toContain('dist/generated.js');
  });
});
