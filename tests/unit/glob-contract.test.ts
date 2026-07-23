import { describe, expect, it } from 'vitest';

import { matchesGlobPattern } from '../../src/mcp/tools/glob.js';

describe('memphis_glob backend-independent pattern contract', () => {
  it.each([
    ['src/mcp/tools/exec.ts', 'src/**/*.ts', true],
    ['src/index.ts', 'src/**/*.ts', true],
    ['src/mcp/tools/exec.ts', '**/exec*.ts', true],
    ['src/mcp/tools/exec.js', '**/exec*.ts', false],
    ['README.md', '*.md', true],
    ['docs/operator/README.md', '*.md', false],
    ['docs/operator/README.md', '**/*.md', true],
    ['src/mcp/tools/git.ts', 'src/mcp/tools/???.ts', true],
  ])('matches %s against %s => %s', (candidate, pattern, expected) => {
    expect(matchesGlobPattern(candidate, pattern)).toBe(expected);
  });
});
