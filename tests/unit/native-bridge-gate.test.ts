/**
 * The native bridge gate must fail on the right things.
 *
 * ## The bug this test exists for
 *
 * The first version of the gate compared the shipped `.node` against the
 * newest `.rs` file under `crates/`. That included `memphis-operator`
 * and `memphis-tui`, which are **not** part of the bridge — they are
 * separate binaries.
 *
 * The consequence was measured on this host: editing
 * `crates/memphis-operator/src/chat_session.rs` made the gate report
 * that the bridge was stale, and `npm run build:rust:release` could not
 * fix it, because the release build does not depend on that crate. A
 * gate that reports a problem no action can fix is a gate people learn
 * to ignore — and this gate exists precisely to catch a silent stale
 * binary.
 *
 * So the gate now compares against the dependency closure of
 * `memphis-napi` only. These tests pin that scope from both sides:
 * an operator edit must NOT invalidate the bridge, and a core edit MUST.
 */

import { mkdirSync, mkdtempSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  bridgeDependencyClosure,
  isDependencySection,
  newestBridgeSource,
  pathDependencies,
} from '../../scripts/lib/native-bridge-graph.mts';

/** A miniature workspace: a bridge crate, one real dependency, one bystander. */
function makeWorkspace(): string {
  const root = mkdtempSync(join(tmpdir(), 'memphis-bridge-graph-'));

  const write = (relativePath: string, content: string): void => {
    const full = join(root, relativePath);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, content, 'utf8');
  };

  write(
    'crates/memphis-napi/Cargo.toml',
    [
      '[package]',
      'name = "memphis-napi"',
      '',
      '[dependencies]',
      'memphis-core = { path = "../memphis-core" }',
      'serde = { workspace = true }',
      '',
      '[dev-dependencies]',
      'memphis-operator = { path = "../memphis-operator" }',
      '',
    ].join('\n'),
  );
  write('crates/memphis-napi/src/lib.rs', 'pub fn napi() {}\n');

  write('crates/memphis-core/Cargo.toml', ['[package]', 'name = "memphis-core"', ''].join('\n'));
  write('crates/memphis-core/src/lib.rs', 'pub fn core() {}\n');

  // A crate that is NOT reachable from the bridge.
  write(
    'crates/memphis-operator/Cargo.toml',
    ['[package]', 'name = "memphis-operator"', ''].join('\n'),
  );
  write('crates/memphis-operator/src/chat_session.rs', 'pub fn operator() {}\n');

  write('Cargo.toml', ['[workspace]', 'members = ["crates/*"]', ''].join('\n'));
  write('Cargo.lock', 'version = 3\n');

  return root;
}

/** Push a file's mtime into the future so "newest" is unambiguous. */
function touchTo(root: string, relativePath: string, epochSeconds: number): void {
  const seconds = epochSeconds;
  utimesSync(join(root, relativePath), seconds, seconds);
}

describe('native bridge dependency closure', () => {
  it('contains the bridge crate and its real dependencies', () => {
    const root = makeWorkspace();
    const closure = bridgeDependencyClosure(root).map((dir) => dir.replace(`${root}/`, ''));
    expect(closure).toContain('crates/memphis-napi');
    expect(closure).toContain('crates/memphis-core');
  });

  it('excludes a crate that is not reachable from the bridge', () => {
    const root = makeWorkspace();
    const closure = bridgeDependencyClosure(root).map((dir) => dir.replace(`${root}/`, ''));
    expect(closure).not.toContain('crates/memphis-operator');
  });

  it('excludes dev-dependencies, which never reach the cdylib', () => {
    const root = makeWorkspace();
    expect(pathDependencies(join(root, 'crates/memphis-napi'))).toEqual(['../memphis-core']);
  });

  it('reads the sub-table and platform-specific dependency forms', () => {
    expect(isDependencySection('dependencies')).toBe(true);
    expect(isDependencySection('dependencies.serde')).toBe(true);
    expect(isDependencySection("target.'cfg(unix)'.dependencies")).toBe(true);
    expect(isDependencySection('build-dependencies')).toBe(true);
    expect(isDependencySection('dev-dependencies')).toBe(false);
    expect(isDependencySection('dev-dependencies.serde')).toBe(false);
    expect(isDependencySection('package')).toBe(false);
    expect(isDependencySection('features')).toBe(false);
  });
});

describe('native bridge staleness scope', () => {
  it('does not treat an edit in a bystander crate as staleness', () => {
    const root = makeWorkspace();
    const before = newestBridgeSource(root);
    touchTo(root, 'crates/memphis-operator/src/chat_session.rs', 4_000_000_000);
    const after = newestBridgeSource(root);
    expect(after.mtime).toBe(before.mtime);
  });

  it('does treat an edit inside the closure as staleness', () => {
    const root = makeWorkspace();
    const before = newestBridgeSource(root);
    touchTo(root, 'crates/memphis-core/src/lib.rs', 4_000_000_000);
    const after = newestBridgeSource(root);
    expect(after.mtime).toBeGreaterThan(before.mtime);
    expect(after.path).toContain('memphis-core');
  });

  it('does treat an edit to the bridge crate itself as staleness', () => {
    const root = makeWorkspace();
    const before = newestBridgeSource(root);
    touchTo(root, 'crates/memphis-napi/src/lib.rs', 4_000_000_000);
    const after = newestBridgeSource(root);
    expect(after.mtime).toBeGreaterThan(before.mtime);
  });

  it('does treat a dependency-graph change as staleness', () => {
    const root = makeWorkspace();
    const before = newestBridgeSource(root);
    touchTo(root, 'Cargo.lock', 4_000_000_000);
    const after = newestBridgeSource(root);
    expect(after.mtime).toBeGreaterThan(before.mtime);
    expect(after.path).toBe('Cargo.lock');
  });
});
