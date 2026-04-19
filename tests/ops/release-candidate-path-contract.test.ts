import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const thisDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(thisDir, '..', '..');

function read(relativePath: string): string {
  return readFileSync(path.join(repoRoot, relativePath), 'utf8');
}

describe('release candidate path contract', () => {
  it('keeps RC prep and final GA release paths explicitly separated', () => {
    const releaseProcess = read(path.join('docs', 'RELEASE-PROCESS.md'));
    const releaseRunbook = read(path.join('docs', 'runbooks', 'RELEASE.md'));
    const readme = read('README.md');

    expect(releaseProcess).toContain(
      './scripts/prepare-release-candidate.sh --version <semver-prerelease>',
    );
    expect(releaseProcess).toContain('.github/workflows/release-draft-dispatch.yml');
    expect(releaseProcess).toContain('./scripts/release.sh [patch|minor|major|--version <semver>]');

    expect(releaseRunbook).toContain('./scripts/prepare-release-candidate.sh --version 1.0.0-rc.1');
    expect(releaseRunbook).toContain(
      'this path creates a **draft** release only; it does not publish the package',
    );
    expect(releaseRunbook).toContain('./scripts/release.sh --version 1.0.0');

    expect(readme).toContain('./scripts/prepare-release-candidate.sh --version 1.2.2-rc.1');
    expect(readme).toContain('.github/workflows/release-draft-dispatch.yml');
    expect(readme).toContain('.github/workflows/release.yml');
  });

  it('keeps the RC prep helper focused on version/changelog + gates without tagging', () => {
    const helper = read(path.join('scripts', 'prepare-release-candidate.sh'));
    const releaseScript = read(path.join('scripts', 'release.sh'));

    expect(helper).toContain('bash ./scripts/run-release-gates.sh');
    expect(helper).toContain('git commit -m "chore(release): ${TAG}"');
    expect(helper).not.toContain('git tag');
    expect(helper).not.toContain('git push origin "${TAG}"');

    expect(releaseScript).toContain('--version <semver>');
    expect(releaseScript).toContain('Use');
    expect(releaseScript).toContain('prepare-release-candidate.sh');
    expect(releaseScript).toContain('git tag "${TAG}"');
  });
});
