import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const thisDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(thisDir, '..', '..');
const pluginDir = path.join(repoRoot, 'openclaw-plugin');

describe('openclaw-plugin archive contract', () => {
  it('marks the package private and removes publishable dist entrypoints', () => {
    const pkg = JSON.parse(readFileSync(path.join(pluginDir, 'package.json'), 'utf8')) as {
      private?: boolean;
      main?: string;
      types?: string;
    };

    expect(pkg.private).toBe(true);
    expect(pkg.main).toBeUndefined();
    expect(pkg.types).toBeUndefined();
  });

  it('fails closed when someone tries to build the archived package', () => {
    const result = spawnSync('npm', ['run', '-s', 'build'], {
      cwd: pluginDir,
      encoding: 'utf8',
      timeout: 120_000,
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('downstream-only reference material');
    expect(result.stderr).toContain('not publishable');
  });
});
