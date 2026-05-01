#!/usr/bin/env node
/**
 * Post-install diagnostic: verify the Memphis NAPI bridge binary is
 * available before the operator hits a confusing runtime error on
 * `memphis vault init` or `memphis chain status`.
 *
 * S9-0 (the smallest viable fix to unbreak `npm install -g`): the
 * Linux x64 prebuilt index.node now ships in the npm tarball.
 * Operators on macOS / Windows / linux-arm64 have no prebuilt yet
 * and need to build from source.
 *
 * Behaviour:
 * - Linux x64: bridge present → silent OK.
 * - Other platforms: print a clear "build from source" hint pointing
 *   at the canonical `npm run build:rust` command, with a one-line
 *   prereq summary (Rust toolchain).
 *
 * Never exits non-zero — npm install must succeed even when the
 * bridge isn't there yet, so the operator can run `memphis init` /
 * `memphis doctor` to get diagnostic guidance.
 *
 * Future PR (S9-1): napi-rs CLI + per-platform optionalDependencies
 * replaces this with a proper distribution; this script becomes the
 * single fallback path.
 */

import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { platform, arch } from 'node:process';

const here = dirname(fileURLToPath(import.meta.url));
const packageRoot = resolve(here, '..');
const bridgePath = join(packageRoot, 'crates', 'memphis-napi', 'index.node');

const IS_LINUX_X64 = platform === 'linux' && arch === 'x64';
const HAS_BRIDGE = existsSync(bridgePath);

if (HAS_BRIDGE && IS_LINUX_X64) {
  // Happy path on the only currently-prebuilt platform.
  process.exit(0);
}

const banner = '┌──────────────────────────────────────────────────────────────────────────┐';
const footer = '└──────────────────────────────────────────────────────────────────────────┘';

function note(line) {
  process.stdout.write(`│ ${line.padEnd(72)} │\n`);
}

process.stdout.write(`\n${banner}\n`);
note('Memphis NAPI bridge: build-from-source required');
note('');
if (!HAS_BRIDGE) {
  note(`No prebuilt binary for ${platform}/${arch} in this package.`);
} else {
  note(`Prebuilt binary in this package targets linux/x64.`);
  note(`You are on ${platform}/${arch} — ignore the bundled binary; rebuild.`);
}
note('');
note('To finish setup:');
note('  1. Install Rust: https://rustup.rs');
note('  2. From the source checkout: npm run build:rust');
note('  3. Run: memphis doctor');
note('');
note('Rust toolchain prereq is documented at:');
note('  docs/operator/CLEAN-INSTALL.md');
process.stdout.write(`${footer}\n\n`);

// Always succeed — the bridge is loaded lazily, so vault/chain/embed
// only fail when the operator actually invokes them. doctor surfaces
// the gap with an actionable fix string.
process.exit(0);
