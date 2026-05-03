/**
 * Parity contract: TS path resolvers (`src/config/paths.ts`) must produce
 * the SAME output as the Rust `memphis-paths` crate via the NAPI bridge
 * (`src/infra/storage/rust-paths-bridge.ts`) for identical inputs.
 *
 * Why this test exists: PR7 added the Rust crate as the single source of
 * truth for path policy. PR8 switched `vault-paths.ts` to call the bridge
 * (the actual split-incident site). `paths.ts` is intentionally NOT
 * migrated — every TS subprocess that imports `getDataDir` would otherwise
 * load the NAPI binary, which compounds the known per-process napi
 * teardown race (issue #270). Keeping the TS table as a parallel
 * implementation is OK ONLY as long as drift is detected: this test fires
 * on any divergence.
 *
 * If a future change to either side breaks parity, fix the divergent
 * side rather than relaxing the test.
 */
import os from 'node:os';

import { describe, expect, it } from 'vitest';

import {
  getChainPath,
  getDataDir,
  normalizeChainName,
} from '../../src/config/paths.js';
import {
  bridgeNormalizeChainName,
  bridgeResolveChainPath,
  bridgeResolveDataDir,
} from '../../src/infra/storage/rust-paths-bridge.js';

function envWithHome(extras: Record<string, string> = {}): NodeJS.ProcessEnv {
  // Both sides need HOME; TS reads `os.homedir()` directly while Rust
  // reads the env map. Surface HOME to the env so the bridge sees it.
  const base: NodeJS.ProcessEnv = { HOME: os.homedir() };
  return { ...base, ...extras };
}

describe('TS paths.ts ↔ memphis-paths NAPI bridge parity', () => {
  it('getDataDir matches bridgeResolveDataDir for default env', () => {
    const env = envWithHome();
    expect(getDataDir(env)).toBe(bridgeResolveDataDir(env));
  });

  it('getDataDir matches for absolute MEMPHIS_DATA_DIR', () => {
    const env = envWithHome({ MEMPHIS_DATA_DIR: '/var/memphis-prod' });
    expect(getDataDir(env)).toBe(bridgeResolveDataDir(env));
  });

  it('getDataDir matches for tilde-prefixed override', () => {
    const env = envWithHome({ MEMPHIS_DATA_DIR: '~/runtime' });
    expect(getDataDir(env)).toBe(bridgeResolveDataDir(env));
  });

  it('getChainPath matches bridge for canonical chain name', () => {
    const env = envWithHome({ MEMPHIS_DATA_DIR: '/var/memphis-prod' });
    expect(getChainPath('journal', env)).toBe(bridgeResolveChainPath('journal', env));
  });

  it('getChainPath matches bridge for aliased chain names (case→cases, etc.)', () => {
    const env = envWithHome({ MEMPHIS_DATA_DIR: '/var/memphis-prod' });
    for (const alias of ['case', 'decision', 'pattern', 'reflection']) {
      expect(getChainPath(alias, env), `alias mismatch for '${alias}'`).toBe(
        bridgeResolveChainPath(alias, env),
      );
    }
  });

  it('getChainPath matches bridge when chain is undefined (bare chains dir)', () => {
    const env = envWithHome({ MEMPHIS_DATA_DIR: '/var/memphis-prod' });
    expect(getChainPath(undefined, env)).toBe(bridgeResolveChainPath('', env));
  });

  it('normalizeChainName table mirrors the Rust alias table exactly', () => {
    // TS `normalizeChainName` returns undefined for undefined; the bridge
    // handles only strings. Compare on real string inputs.
    for (const alias of ['case', 'decision', 'pattern', 'reflection']) {
      expect(normalizeChainName(alias), `TS alias '${alias}'`).toBe(
        bridgeNormalizeChainName(alias),
      );
    }
    // Pass-through cases: non-aliased names stay unchanged on both sides.
    for (const name of ['cases', 'journal', 'audit', 'patterns', 'reflections']) {
      expect(normalizeChainName(name), `TS pass-through '${name}'`).toBe(
        bridgeNormalizeChainName(name),
      );
    }
  });
});
