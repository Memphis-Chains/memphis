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
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import process from 'node:process';

const { platform, arch } = process;

const here = dirname(fileURLToPath(import.meta.url));
const packageRoot = resolve(here, '..');
const bridgePath = join(packageRoot, 'crates', 'memphis-napi', 'index.node');

// Codex P2 round 1: the prebuilt is built on ubuntu-latest in
// `.github/workflows/release.yml`, so it's a glibc-linked binary.
// Alpine/musl hosts also report platform=linux + arch=x64 but the
// bundled .node won't load there. Node exposes glibcVersionRuntime
// in process.report — undefined on musl, version string on glibc.
function isGlibcLinux() {
  if (platform !== 'linux') return false;
  try {
    const report = process.report?.getReport?.() ?? {};
    const header = report.header ?? {};
    return typeof header.glibcVersionRuntime === 'string';
  } catch {
    return false;
  }
}

// Codex P1 round 2: even on glibc Linux x64, the binary built on
// ubuntu-latest may require newer glibc symbols than the host has
// (older Debian/RHEL/Ubuntu LTS). Probing presence + libc family is
// not enough — actually try to load the .node and catch
// ABI/symbol-mismatch errors. This is the only definitive check.
//
// We do this in the postinstall (parent) process: the require throws
// synchronously on incompatible glibc with a clear "GLIBC_x.y not
// found" or "version `GLIBC_X.Y' not found" message, which we surface
// to the operator with the same rebuild-from-source guidance.
function probeBridgeLoad() {
  if (!existsSync(bridgePath)) {
    return { ok: false, reason: 'missing' };
  }
  try {
    const req = createRequire(import.meta.url);
    req(bridgePath);
    return { ok: true };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, reason: 'load-failed', detail: message };
  }
}

const probe = probeBridgeLoad();

if (probe.ok && arch === 'x64' && isGlibcLinux()) {
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
if (probe.reason === 'missing') {
  note(`No prebuilt binary for ${platform}/${arch} in this package.`);
} else if (probe.reason === 'load-failed') {
  // Probe-load detected real ABI mismatch — glibc too old, musl
  // host, or arch/platform mismatch. The error message names the
  // missing symbol (e.g. `GLIBC_2.39 not found`) so surface it.
  note(`Bundled binary present but failed to load on this host:`);
  const detail = String(probe.detail ?? '').slice(0, 200);
  if (detail) note(`  ${detail}`);
  note(`Rebuild from source to get a binary matching this host's libc/abi.`);
} else if (platform === 'linux' && arch === 'x64' && !isGlibcLinux()) {
  // Defensive fallback (shouldn't trigger after probe-load above).
  note(`Bundled binary targets glibc Linux x64; this host appears to be musl.`);
  note(`Ignore the bundled binary and rebuild from source.`);
} else {
  note(`Prebuilt binary in this package targets glibc-linux/x64.`);
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
