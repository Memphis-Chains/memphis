import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const thisDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(thisDir, '..', '..');

function read(relativePath: string): string {
  return readFileSync(path.join(repoRoot, relativePath), 'utf8');
}

describe('public status and license docs contract', () => {
  it('keeps README on the current release truth with canonical status and roadmap links', () => {
    const readme = read('README.md');

    expect(readme).toContain('`v1.2.1`');
    expect(readme).toContain('operational but not yet broadly stable');
    expect(readme).toContain('docs/PROJECT-STATUS.md');
    expect(readme).toContain('docs/ROADMAP-CURRENT.md');
    expect(readme).toContain('docs/CLEAN-INSTALL.md');
    expect(readme).toContain('Worker / Async Runtime');
  });

  it('keeps the docs index and release docs aligned with the new canonical status stack', () => {
    const docsIndex = read(path.join('docs', 'README.md'));
    const cleanInstall = read(path.join('docs', 'CLEAN-INSTALL.md'));
    const projectStatus = read(path.join('docs', 'PROJECT-STATUS.md'));
    const roadmap = read(path.join('docs', 'ROADMAP-CURRENT.md'));
    const publishStatus = read(path.join('docs', 'PUBLISH-STATUS.md'));
    const executionPlan = read(path.join('docs', 'EXECUTION-PLAN.md'));
    const changelog = read('CHANGELOG.md');

    expect(docsIndex).toContain('Project Status');
    expect(docsIndex).toContain('Current Roadmap');
    expect(docsIndex).toContain('Clean Install');
    expect(cleanInstall).toContain('git clone https://github.com/Memphis-Chains/memphis.git');
    expect(cleanInstall).toContain('npm run bootstrap');
    expect(cleanInstall).toContain('memphis init');
    expect(projectStatus).toContain('latest published release is `v1.2.1`');
    expect(projectStatus).toContain('operational but not yet broadly stable');
    expect(roadmap).toContain('The Last Month: What Actually Happened');
    expect(roadmap).toContain('M1. Documentation and public truth closure');
    expect(publishStatus).toContain('latest published release: `v1.2.1`');
    expect(publishStatus).toContain('Current published tag verified in-repo: `v1.2.1`');
    expect(executionPlan).toContain('For the current state of `main`, use:');
    expect(changelog).toMatch(/^## Unreleased/m);
  });

  it('keeps Apache-2.0 explicit and consistent across the public docs contract', () => {
    const readme = read('README.md');
    const licenseFile = read('LICENSE');
    const packageJson = read('package.json');

    expect(readme).toContain('Apache License 2.0');
    expect(readme).toContain('Apache-2.0');
    expect(licenseFile).toContain('Apache License');
    expect(licenseFile).toContain('Version 2.0, January 2004');
    expect(packageJson).toContain('"license": "Apache-2.0"');
  });
});
