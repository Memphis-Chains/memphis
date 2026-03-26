import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const thisDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(thisDir, '..', '..');

const node22Docs = [
  'README.md',
  'INSTALL.md',
  'docs/GETTING-STARTED.md',
  'docs/INSTALLATION.md',
  'docs/OPERATIONS-MANUAL.md',
  'docs/TROUBLESHOOTING.md',
  'docs/RE-INSTALL.md',
];

const sourceFirstDocs = [
  'README.md',
  'INSTALL.md',
  'docs/GETTING-STARTED.md',
  'docs/INSTALLATION.md',
  'docs/PACKAGE-PUBLISH.md',
  'docs/RELEASE-PROCESS.md',
];

const workflowPaths = [
  '.github/workflows/ci.yml',
  '.github/workflows/nightly-crystal.yml',
  '.github/workflows/publish-package.yml',
  '.github/workflows/release-draft-dispatch.yml',
  '.github/workflows/release.yml',
];

function read(relativePath: string): string {
  return readFileSync(path.join(repoRoot, relativePath), 'utf8');
}

describe('install/release support matrix contract', () => {
  it('pins the repo support matrix to Node 22 LTS', () => {
    const packageJson = read('package.json');
    const installScript = read('scripts/install.sh');
    const prerequisitesScript = read('scripts/install-prerequisites.sh');
    const dependencyChecks = read('src/infra/cli/utils/dependencies.ts');

    expect(packageJson).toContain('"node": ">=22"');
    expect(installScript).toContain('SUPPORTED_NODE_MAJOR=22');
    expect(prerequisitesScript).toContain('setup_22.x');
    expect(dependencyChecks).toContain("minimum: '22.0.0'");
    expect(dependencyChecks).toContain('Node.js 22 LTS or newer');
  });

  it('keeps active operator docs on the Node 22 baseline with no stale Node 24 guidance', () => {
    for (const docPath of node22Docs) {
      const markdown = read(docPath);
      expect(markdown).not.toMatch(/setup_24\.x|node@24|v24\+|Node\.js v24|node -v` is below 24/i);
    }
  });

  it('documents source checkout plus bootstrap as the canonical full-runtime path', () => {
    for (const docPath of sourceFirstDocs) {
      const markdown = read(docPath);
      expect(markdown).toMatch(/source checkout|source-checkout/i);
      expect(markdown).toMatch(/bootstrap/i);
    }

    const packagePublish = read('docs/PACKAGE-PUBLISH.md');
    expect(packagePublish).toMatch(/bounded CLI\/distribution path/i);
    expect(packagePublish).not.toMatch(/package-first/i);
  });

  it('keeps the production brief explicitly non-canonical and current-tooling aware', () => {
    const brief = read('PRODUCTION-BRIEF.md');

    expect(brief).toContain('Non-canonical planning note.');
    expect(brief).toContain('docs/EXECUTION-PLAN.md');
    expect(brief).toContain('source checkout plus bootstrap');
    expect(brief).not.toContain('memphis_self_learn');
    expect(brief).not.toContain('memphis_self_recall');
  });

  it('keeps release workflows on the same Node 22 / v5 actions baseline', () => {
    for (const workflowPath of workflowPaths) {
      const workflow = read(workflowPath);
      expect(workflow).toContain('actions/checkout@v5');
      expect(workflow).toContain('actions/setup-node@v5');
      expect(workflow).not.toContain('actions/checkout@v4');
      expect(workflow).not.toContain('actions/setup-node@v4');
      expect(workflow).toMatch(/node-version:\s*'?(22)'?/);
    }
  });
});
