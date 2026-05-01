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
