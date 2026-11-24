import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import {
  ARTIFACT_PATH,
  RUNTIME_CLOSURE_SCHEMA_VERSION,
  collectRuntimeEdges,
  findUncoveredEdges,
  readDeclaredPackageFiles,
  type RuntimeClosureArtifact,
} from '../../scripts/check-package-runtime-closure.mts';

const thisDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(thisDir, '..', '..');

/**
 * The runner for the package runtime closure.
 *
 * It imports the OWNER (`scripts/check-package-runtime-closure.mts`) instead of
 * re-implementing the discovery: a test that rediscovers the edges would only
 * prove that two implementations agree, not that the package ships what the
 * runtime loads. The owner produces the artefact; this file checks it.
 *
 * The regression this pins is concrete. v1.14.0 failed to publish because
 * `src/infra/cli/commands/backup-manifest.ts` imports
 * `scripts/backup-manifest.mjs` — a module-load-time import — and
 * `package.json`'s `files` did not list that module. The tarball shipped
 * `dist/infra/cli/commands/backup-manifest.js` without the module it imports,
 * so EVERY CLI command died with "Cannot find module".
 */
describe('ops:check-package-runtime-closure', () => {
  it('covers every cross-boundary runtime file with a package.json "files" entry', () => {
    const edges = collectRuntimeEdges();
    const uncovered = findUncoveredEdges(edges);

    expect(uncovered).toEqual([]);
    expect(edges.length).toBeGreaterThan(0);
  });

  it('publishes the manifest module that broke the v1.14.0 tarball', () => {
    const declared = readDeclaredPackageFiles();

    expect(declared).toContain('scripts/backup-manifest.mjs');
    expect(declared).toContain('scripts/backup-db-snapshot.mjs');
  });

  it('keeps the artefact in step with the discovered edges', () => {
    expect(existsSync(ARTIFACT_PATH)).toBe(true);

    const artifact = JSON.parse(readFileSync(ARTIFACT_PATH, 'utf8')) as RuntimeClosureArtifact;

    expect(artifact.schemaVersion).toBe(RUNTIME_CLOSURE_SCHEMA_VERSION);
    expect(artifact.edges).toEqual(collectRuntimeEdges());
  });

  it('exits zero in --check mode', () => {
    const result = spawnSync(
      'npm',
      ['run', '-s', 'ops:check-package-runtime-closure', '--', '--check'],
      { cwd: repoRoot, encoding: 'utf8', timeout: 120_000 },
    );

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('[PASS] package runtime closure');
  });
});
