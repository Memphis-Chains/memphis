/**
 * Native bridge freshness gate.
 *
 * ## Why this exists
 *
 * The Rust core is the authority for the chains, the vault, the
 * embeddings and the block vocabulary. TypeScript reaches it through one
 * N-API binary. Nothing connected that binary to its source, so:
 *
 * - editing a Rust file and running `npm run build` (which only rebuilds
 *   TypeScript) left the service running the *old* Rust code, silently;
 * - two different Rust binaries were reachable on one host — the service
 *   loaded the release `.so`, while every CLI invocation outside systemd
 *   resolved the in-tree `index.node`, which was a debug build. The
 *   runtime and the operator's shell could therefore disagree about what
 *   the vault contained.
 *
 * `scripts/postinstall-check-native.mjs` checks presence and loadability
 * only, and deliberately always exits 0 — it cannot answer "is this the
 * code I just wrote?".
 *
 * ## What it checks
 *
 * 1. The shipped artifact `crates/memphis-napi/index.node` exists.
 * 2. It is not older than the newest source that can change it — the
 *    dependency closure of `memphis-napi`, computed from the manifests
 *    by `scripts/lib/native-bridge-graph.mts`. Sources outside that
 *    closure (`memphis-operator`, `memphis-tui`) are separate binaries
 *    and cannot make the bridge stale.
 * 3. It is the same file as the release build the service installs —
 *    `target/release/libmemphis_napi.so`. Two artifacts that differ are
 *    the split brain.
 *
 * A failure means: rebuild the bridge (`npm run build:rust:release`).
 *
 * Run: `npm run -s ops:check-native-bridge`
 */

import { createHash } from 'node:crypto';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';

import { bridgeDependencyClosure, newestBridgeSource } from './lib/native-bridge-graph.mts';

const REPO_ROOT = resolve('.');
const CRATES_DIR = join(REPO_ROOT, 'crates');
const SHIPPED_BRIDGE = join(CRATES_DIR, 'memphis-napi', 'index.node');
const RELEASE_BRIDGE = join(REPO_ROOT, 'target', 'release', 'libmemphis_napi.so');

interface Finding {
  problem: string;
  hint: string;
}

const findings: Finding[] = [];

/** Content hash — the shipped bridge is a copy, so timestamps lie. */
function hashFile(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

if (!existsSync(SHIPPED_BRIDGE)) {
  findings.push({
    problem: `the shipped native bridge is missing: ${relative(REPO_ROOT, SHIPPED_BRIDGE)}`,
    hint: 'run `npm run build:rust:release`',
  });
} else {
  const shippedMtime = statSync(SHIPPED_BRIDGE).mtimeMs;
  const source = newestBridgeSource(REPO_ROOT);
  if (source.mtime > shippedMtime) {
    findings.push({
      problem:
        `the native bridge is stale: ${relative(REPO_ROOT, SHIPPED_BRIDGE)} was built at ` +
        `${new Date(shippedMtime).toISOString()}, but ${source.path} changed at ` +
        `${new Date(source.mtime).toISOString()}`,
      hint: 'run `npm run build:rust:release` — the runtime is otherwise running Rust code that no longer exists',
    });
  }

  if (existsSync(RELEASE_BRIDGE)) {
    const releaseMtime = statSync(RELEASE_BRIDGE).mtimeMs;
    // The shipped file is a COPY of the release build, so it is always
    // newer than the file it was copied from. Compare the CONTENT, not
    // the timestamps.
    const shippedHash = hashFile(SHIPPED_BRIDGE);
    const releaseHash = hashFile(RELEASE_BRIDGE);
    if (shippedHash !== releaseHash) {
      findings.push({
        problem:
          'the shipped bridge and the release build are different artifacts: ' +
          `${relative(REPO_ROOT, SHIPPED_BRIDGE)} is ${shippedHash.slice(0, 12)}…, ` +
          `${relative(REPO_ROOT, RELEASE_BRIDGE)} is ${releaseHash.slice(0, 12)}…`,
        hint:
          'run `npm run build:rust:release` — the service installs the release build while ' +
          'the CLI resolves the shipped one, and the two must be the same code',
      });
    }
    if (releaseMtime > shippedMtime) {
      findings.push({
        problem:
          `the release build is newer than the shipped bridge ` +
          `(${new Date(releaseMtime).toISOString()} > ${new Date(shippedMtime).toISOString()})`,
        hint: 'run `npm run build:rust:release` — the shipped bridge was never refreshed',
      });
    }
  }
}

if (findings.length > 0) {
  console.error('native bridge freshness gate FAILED\n');
  for (const finding of findings) {
    console.error(`  ${finding.problem}`);
    console.error(`    → ${finding.hint}`);
  }
  console.error('');
  process.exit(1);
}

console.log(
  `native bridge freshness gate OK — ${relative(REPO_ROOT, SHIPPED_BRIDGE)} is newer than every ` +
    `source in the bridge closure (${bridgeDependencyClosure(REPO_ROOT)
      .map((dir) => relative(REPO_ROOT, dir))
      .join(', ')})`,
);
