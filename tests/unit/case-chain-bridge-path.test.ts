/**
 * The case bridge resolves its path through the CENTRAL resolver.
 *
 * ## Why this gate exists
 *
 * `src/infra/storage/case-chain-adapter.ts` used to resolve the bridge with
 * its own line:
 *
 * ```ts
 * rawEnv.RUST_CHAIN_BRIDGE_PATH ?? './crates/memphis-napi'
 * ```
 *
 * The relative path was resolved against `process.cwd()`. The vault, the
 * embed and the chain adapters had all been moved onto the central resolver
 * (`resolveRustBridgePath`) after the 2026-04-26 incident, when an operator
 * running `memphis` from $HOME hit "Rust vault bridge not found at
 * ./crates/memphis-napi" — and the file that documented the fix named this
 * exact footgun. **This one survived it.**
 *
 * The consequence was not an error: the bridge simply failed to load, and
 * `CaseChainAdapter.rustAvailable` flipped to `false`, so the adapter fell
 * back to the TypeScript implementation of the same rule. Two
 * implementations of one rule, chosen by the working directory.
 *
 * The sibling gate for the vault is `tests/unit/rust-vault-bridge-path.test.ts`.
 */

import { resolve } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { resetInstallRootMemoForTests } from '../../src/infra/runtime/install-root.js';
import { getCaseChainAdapterStatus } from '../../src/infra/storage/case-chain-adapter.js';

const installRoot = resolve(import.meta.dirname, '../..');

afterEach(() => {
  resetInstallRootMemoForTests();
});

describe('the case bridge path anchoring', () => {
  it('respects an absolute RUST_CHAIN_BRIDGE_PATH override verbatim', () => {
    const status = getCaseChainAdapterStatus({
      RUST_CHAIN_ENABLED: 'true',
      RUST_CHAIN_BRIDGE_PATH: '/explicit/operator/override',
    } as NodeJS.ProcessEnv);

    expect(status.rustBridgePath).toBe('/explicit/operator/override');
  });

  it('resolves a RELATIVE override against the install root, not the cwd', () => {
    // The legacy .env shipped with `RUST_CHAIN_BRIDGE_PATH=./crates/memphis-napi`.
    // Verbatim, that string is resolved against the working directory, which
    // is how the vault adapter broke for an operator in $HOME.
    const original = process.cwd();
    try {
      process.chdir('/tmp');
      const status = getCaseChainAdapterStatus({
        RUST_CHAIN_ENABLED: 'true',
        RUST_CHAIN_BRIDGE_PATH: './crates/memphis-napi',
        MEMPHIS_RUNTIME_ROOT: installRoot,
      } as NodeJS.ProcessEnv);

      expect(status.rustBridgePath.startsWith('/')).toBe(true);
      expect(status.rustBridgePath).toBe(resolve(installRoot, 'crates/memphis-napi'));
    } finally {
      process.chdir(original);
    }
  });

  it('defaults to an absolute path under the install root', () => {
    const status = getCaseChainAdapterStatus({
      RUST_CHAIN_ENABLED: 'true',
      MEMPHIS_RUNTIME_ROOT: installRoot,
    } as NodeJS.ProcessEnv);

    expect(status.rustBridgePath.startsWith('/')).toBe(true);
    expect(status.rustBridgePath.endsWith('crates/memphis-napi')).toBe(true);
  });

  it('the default path does not depend on the working directory', () => {
    const original = process.cwd();
    try {
      process.chdir('/tmp');
      const status = getCaseChainAdapterStatus({
        RUST_CHAIN_ENABLED: 'true',
        MEMPHIS_RUNTIME_ROOT: installRoot,
      } as NodeJS.ProcessEnv);

      expect(status.rustBridgePath).toBe(resolve(installRoot, 'crates/memphis-napi'));
    } finally {
      process.chdir(original);
    }
  });

  it('the bridge is found from a working directory that has no crates/', () => {
    // The whole point: from /tmp, the bridge is still reachable, so the
    // adapter keeps using the Rust implementation instead of silently
    // switching to the TypeScript one.
    const original = process.cwd();
    try {
      process.chdir('/tmp');
      const status = getCaseChainAdapterStatus({
        RUST_CHAIN_ENABLED: 'true',
        MEMPHIS_RUNTIME_ROOT: installRoot,
      } as NodeJS.ProcessEnv);

      expect(status.bridgeLoaded).toBe(true);
      expect(status.caseApiAvailable).toBe(true);
    } finally {
      process.chdir(original);
    }
  });
});
