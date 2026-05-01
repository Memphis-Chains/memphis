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

  it('prepack uses release build, not debug — Codex P1 round 1 caught prepack clobbering release binary', () => {
    // Codex round 1: prior revision had the release CI build the
    // bridge then `npm pack` re-ran `prepack: npm run build` which
    // clobbered it with a 52MB debug-mode workspace build. Now
    // prepack→build:release→build:rust:release ships the 6.4MB
    // stripped release artifact.
    const pkg = JSON.parse(readFileSync(path.join(repoRoot, 'package.json'), 'utf8')) as {
      scripts?: { prepack?: string; 'build:release'?: string; 'build:rust:release'?: string };
    };
    expect(pkg.scripts?.prepack).toBe('npm run build:release');
    expect(pkg.scripts?.['build:release']).toContain('build:rust:release');
    // Release-mode rust build is targeted at the napi crate only +
    // explicit --release; if either token disappears, package size
    // regresses to ~50MB compressed (debug + workspace).
    const rustRelease = pkg.scripts?.['build:rust:release'] ?? '';
    expect(rustRelease).toContain('--release');
    expect(rustRelease).toContain('memphis-napi');
  });

  it('ships the NAPI bridge binary (S9-0 — fresh-install npm package was broken without it)', () => {
    // 2026-05-01 audit found the 52MB committed Linux x64 binary at
    // crates/memphis-napi/index.node was NOT in files[], so
    // `npm install -g @memphis-chains/memphis` shipped TS code only —
    // every consumer machine silently failed on vault/chain/embed at
    // runtime. v1.8.0 release blocker fix: include the binary so at
    // least Linux x64 npm installs work. macOS/arm64/Windows
    // build-from-source via the postinstall guidance until S9-1
    // adopts napi-rs CLI for per-platform sub-packages.
    const pkg = JSON.parse(readFileSync(path.join(repoRoot, 'package.json'), 'utf8')) as {
      files?: string[];
      scripts?: { postinstall?: string };
    };
    expect(pkg.files).toContain('crates/memphis-napi/index.node');
    expect(pkg.files).toContain('scripts/postinstall-check-native.mjs');
    expect(pkg.scripts?.postinstall).toMatch(/postinstall-check-native\.mjs/);
  });
});
