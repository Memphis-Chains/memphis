import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const thisDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(thisDir, '..', '..');

function read(relativePath: string): string {
  return readFileSync(path.join(repoRoot, relativePath), 'utf8');
}

describe('OpenClaw docs truth contract', () => {
  it('keeps active operator docs off deprecated OpenClaw install paths', () => {
    const postInstall = read(path.join('docs', 'operator', 'POST-INSTALLATION.md'));
    const reinstall = read(path.join('docs', 'operator', 'RE-INSTALL.md'));

    expect(postInstall).not.toContain('OPENCLAW-INTEGRATION.md');
    expect(postInstall).toContain('not part of the active');
    expect(postInstall).toContain('Memphis `v1.x` operator flow');

    expect(reinstall).toContain('OpenClaw is deprecated/downstream only');
    expect(reinstall).toContain('does not provide a supported OpenClaw plugin install path');
    expect(reinstall).toContain('outside the Memphis `v1.x` reinstall path');
    expect(reinstall).not.toContain('packages/@memphis/openclaw-plugin');
  });
});
