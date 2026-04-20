import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const thisDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(thisDir, '..', '..');

describe('published package files contract', () => {
  it('keeps deprecated OpenClaw docs out of the published package file list', () => {
    const pkg = JSON.parse(readFileSync(path.join(repoRoot, 'package.json'), 'utf8')) as {
      files?: string[];
    };

    expect(Array.isArray(pkg.files)).toBe(true);
    expect(pkg.files).not.toContain('docs/OPENCLAW-INTEGRATION.md');
    // v1.4.0 release deliberately dropped docs/ from the npm package
    // (see release commit f551665: "minimal files array — drop docs/").
    expect(pkg.files).not.toContain('docs/GETTING-STARTED.md');
  });
});
