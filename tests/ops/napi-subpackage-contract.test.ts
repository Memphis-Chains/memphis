import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

/**
 * S9-1c contract: every per-platform NAPI sub-package under
 * `crates/memphis-napi/npm/<triple>/` must declare the right `os`/`cpu`/`libc`
 * keys so npm picks the right one via `optionalDependencies` resolution.
 *
 * The matrix here mirrors:
 *   - `src/infra/storage/napi-contract.ts:detectPlatformTriple` (load-side)
 *   - `.github/workflows/prebuilds.yml` matrix (publish-side)
 *
 * Adding a new triple = 3 places to update; this test catches the case
 * where someone adds the directory but forgets the runtime resolver or
 * the build matrix.
 */

const thisDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(thisDir, '..', '..');
const npmDir = path.join(repoRoot, 'crates', 'memphis-napi', 'npm');

interface SubPackageJson {
  name: string;
  version: string;
  main: string;
  files: string[];
  os: string[];
  cpu: string[];
  libc?: string[];
  publishConfig?: { registry?: string };
}

function readSubPackage(triple: string): SubPackageJson {
  const pkgPath = path.join(npmDir, triple, 'package.json');
  return JSON.parse(readFileSync(pkgPath, 'utf8')) as SubPackageJson;
}

const EXPECTED_TRIPLES: ReadonlyArray<{
  triple: string;
  os: string;
  cpu: string;
  libc?: string;
}> = [
  { triple: 'linux-x64-gnu', os: 'linux', cpu: 'x64', libc: 'glibc' },
  { triple: 'linux-arm64-gnu', os: 'linux', cpu: 'arm64', libc: 'glibc' },
  { triple: 'darwin-x64', os: 'darwin', cpu: 'x64' },
  { triple: 'darwin-arm64', os: 'darwin', cpu: 'arm64' },
];

describe('NAPI sub-package contract', () => {
  it('every expected triple has a corresponding sub-package directory', () => {
    const dirsOnDisk = readdirSync(npmDir).filter((entry) => {
      try {
        return statSync(path.join(npmDir, entry)).isDirectory();
      } catch {
        return false;
      }
    });
    const triplesExpected = EXPECTED_TRIPLES.map((e) => e.triple).sort();
    const triplesOnDisk = dirsOnDisk.sort();
    expect(triplesOnDisk).toEqual(triplesExpected);
  });

  for (const { triple, os, cpu, libc } of EXPECTED_TRIPLES) {
    describe(`sub-package: ${triple}`, () => {
      const pkg = readSubPackage(triple);

      it('uses the @memphis-chains scope and matches the triple', () => {
        expect(pkg.name).toBe(`@memphis-chains/memphis-${triple}`);
      });

      it('declares the correct os key', () => {
        expect(pkg.os).toEqual([os]);
      });

      it('declares the correct cpu key', () => {
        expect(pkg.cpu).toEqual([cpu]);
      });

      if (libc !== undefined) {
        it('declares the correct libc key (Linux only)', () => {
          expect(pkg.libc).toEqual([libc]);
        });
      } else {
        it('omits the libc key (only Linux declares libc)', () => {
          expect(pkg.libc).toBeUndefined();
        });
      }

      it('points main at index.node and files contains it', () => {
        expect(pkg.main).toBe('index.node');
        expect(pkg.files).toContain('index.node');
      });

      it('targets GH Packages registry', () => {
        // Mirrors root package.json publishConfig — pre-NPM_TOKEN release path.
        expect(pkg.publishConfig?.registry).toBe('https://npm.pkg.github.com');
      });

      it('starts with the placeholder version (CI rewrites at publish time)', () => {
        // prebuilds.yml rewrites this to the actual tag version on `v*` push.
        // If a contributor edits manually, the build still works (npm publish
        // picks up whatever the file says) but the placeholder convention
        // signals "this gets rewritten in CI".
        expect(pkg.version).toBe('0.0.0-placeholder');
      });
    });
  }

  it('root package.json optionalDependencies lists every triple', () => {
    const rootPkgPath = path.join(repoRoot, 'package.json');
    const rootPkg = JSON.parse(readFileSync(rootPkgPath, 'utf8')) as {
      optionalDependencies?: Record<string, string>;
    };
    const optDeps = rootPkg.optionalDependencies ?? {};
    for (const { triple } of EXPECTED_TRIPLES) {
      const subPackageName = `@memphis-chains/memphis-${triple}`;
      expect(optDeps[subPackageName]).toBeDefined();
    }
  });

  it('prebuilds.yml workflow lists every triple in its matrix', () => {
    const workflow = readFileSync(
      path.join(repoRoot, '.github', 'workflows', 'prebuilds.yml'),
      'utf8',
    );
    for (const { triple } of EXPECTED_TRIPLES) {
      expect(workflow).toContain(`triple: ${triple}`);
    }
  });
});
