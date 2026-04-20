import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const thisDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(thisDir, '..', '..');

function read(relativePath: string): string {
  return readFileSync(path.join(repoRoot, relativePath), 'utf8');
}

describe('onboarding docs truth contract', () => {
  it('keeps active first-run docs on the bootstrap -> init story', () => {
    for (const docPath of [
      'README.md',
      'docs/operator/GETTING-STARTED.md',
      'docs/operator/INSTALLATION.md',
      'docs/operator/GUIDE-FIRST-BOOTSTRAP.md',
      'docs/operator/ONBOARDING-INSTALL.md',
      'docs/operator/USER-QUICKSTART-GITHUB.md',
      'docs/operator/POST-INSTALLATION.md',
    ]) {
      const markdown = read(docPath);
      expect(markdown).toMatch(/bootstrap/i);
      expect(markdown).toContain('memphis init');
    }
  });

  it('keeps generated and user-facing CLI docs off legacy onboarding command lists', () => {
    const apiCli = read(path.join('docs', 'api', 'cli.md'));
    const cliReference = read(path.join('docs', 'operator', 'CLI-REFERENCE.md'));

    expect(apiCli).toContain('- `memphis init`');
    expect(apiCli).toContain('- `memphis setup matrix`');
    expect(apiCli).not.toContain('- `memphis onboarding wizard|bootstrap`');
    expect(apiCli).not.toContain('- `memphis configure`');

    expect(cliReference).toContain('`init` (canonical controlled first-run)');
    expect(cliReference).toContain('`setup matrix`');
    expect(cliReference).toContain('Legacy compatibility commands');
  });
});
