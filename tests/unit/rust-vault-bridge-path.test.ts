/**
 * Verifies the Rust vault bridge path is anchored to the Memphis install
 * root, not `process.cwd()`.
 *
 * Why: operator hit `Vault secret write failed: Rust vault bridge not found
 * at ./crates/memphis-napi` running `memphis provider add minimax` from
 * $HOME on 2026-04-26. The bridge artifact existed at
 * `<installRoot>/crates/memphis-napi/index.node`, but `getBridgePath`
 * returned `'./crates/memphis-napi'` (relative), so `loadBridgeModule`'s
 * `createRequire(\`${process.cwd()}/\`)` resolved against `~`, not the
 * install tree. The CLI on PATH was effectively broken from any directory
 * other than the source checkout.
 *
 * The fix anchors the default to `resolveInstallRoot(...)`. These tests
 * pin the behaviour: env override wins, default is absolute path under
 * the install root, and the fallback string is preserved when no install
 * root can be resolved.
 */

import { afterEach, describe, expect, it } from 'vitest';

import { resetInstallRootMemoForTests } from '../../src/infra/runtime/install-root.js';
import { getRustVaultAdapterStatus } from '../../src/infra/storage/rust-vault-adapter.js';

afterEach(() => {
  resetInstallRootMemoForTests();
});

describe('rust vault bridge path anchoring', () => {
  it('respects an absolute RUST_CHAIN_BRIDGE_PATH override verbatim', () => {
    const out = getRustVaultAdapterStatus({
      RUST_CHAIN_ENABLED: 'true',
      RUST_CHAIN_BRIDGE_PATH: '/explicit/operator/override',
    } as NodeJS.ProcessEnv);

    // Absolute path → bridgePath must be the override, not rewritten.
    expect(out.rustBridgePath).toBe('/explicit/operator/override');
  });

  it('resolves a RELATIVE RUST_CHAIN_BRIDGE_PATH against installRoot, not cwd', () => {
    // Operator's reported failure mode 2026-04-26: legacy .env shipped
    // with `RUST_CHAIN_BRIDGE_PATH=./crates/memphis-napi`. With pure
    // override-verbatim semantics, this string was passed through to
    // loadBridgeModule which resolved it against `process.cwd()`,
    // breaking vault writes from any directory other than the checkout.
    const original = process.cwd();
    try {
      process.chdir('/tmp');
      const out = getRustVaultAdapterStatus({
        RUST_CHAIN_ENABLED: 'true',
        RUST_CHAIN_BRIDGE_PATH: './crates/memphis-napi',
      } as NodeJS.ProcessEnv);

      // Must resolve to an absolute path under the install root, NOT /tmp/...
      expect(out.rustBridgePath.startsWith('/')).toBe(true);
      expect(out.rustBridgePath.startsWith('/tmp/')).toBe(false);
      expect(out.rustBridgePath.endsWith('crates/memphis-napi')).toBe(true);
    } finally {
      process.chdir(original);
    }
  });

  it('default bridge path is absolute and anchored to the install root', () => {
    // No override → resolved via resolveInstallRoot, which walks up from
    // this file's location to the @memphis-chains/memphis package.json.
    // We don't assert the exact path string (varies by checkout location),
    // but it MUST be absolute (start with /) and end with the canonical
    // crates/memphis-napi suffix.
    const out = getRustVaultAdapterStatus({
      RUST_CHAIN_ENABLED: 'true',
    } as NodeJS.ProcessEnv);

    expect(out.rustBridgePath.startsWith('/')).toBe(true);
    expect(out.rustBridgePath.endsWith('crates/memphis-napi')).toBe(true);
  });

  it('default path is independent of process.cwd()', () => {
    // Simulate the operator's broken-from-$HOME scenario: cwd is a
    // directory that has no crates/memphis-napi underneath. Without the
    // fix, the path would resolve relative to that cwd.
    const original = process.cwd();
    try {
      process.chdir('/tmp');
      const out = getRustVaultAdapterStatus({
        RUST_CHAIN_ENABLED: 'true',
      } as NodeJS.ProcessEnv);

      expect(out.rustBridgePath.startsWith('/tmp/')).toBe(false);
      expect(out.rustBridgePath.endsWith('crates/memphis-napi')).toBe(true);
    } finally {
      process.chdir(original);
    }
  });
});
