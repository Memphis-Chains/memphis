/**
 * Sprint B — paths-bridge identity test.
 *
 * Pre-Sprint B: `src/config/paths.ts` had its own TS path-resolution
 * implementation that ran in parallel with `crates/memphis-paths`. Any
 * env override that one side handled and the other didn't created a
 * silent split (operator-incident 2026-04-29 — vault visible to TS,
 * unreadable from Rust).
 *
 * Post-Sprint B: paths.ts wraps the bridge directly. This test
 * collapses to an identity check — for every override scenario we
 * care about, calling `getDataDir`/`getChainPath`/`normalizeChainName`
 * goes through `crates/memphis-paths` and the result is byte-stable.
 *
 * If this file ever needs another fork in logic, it's a sign someone
 * is reintroducing a TS-side resolver. Don't.
 */
import { describe, expect, it } from 'vitest';

import { getChainPath, getDataDir, normalizeChainName } from '../../src/config/paths.js';
import {
  bridgeNormalizeChainName,
  bridgeResolveChainPath,
  bridgeResolveChainsDir,
  bridgeResolveDataDir,
  pathsBridgeAvailable,
} from '../../src/infra/storage/rust-paths-bridge.js';

describe('paths-bridge parity (Sprint B)', () => {
  it('bridge is loadable in this build', () => {
    expect(pathsBridgeAvailable()).toBe(true);
  });

  it('getDataDir → bridgeResolveDataDir for explicit override', () => {
    const env = { MEMPHIS_DATA_DIR: '/tmp/memphis-parity' } as NodeJS.ProcessEnv;
    expect(getDataDir(env)).toBe(bridgeResolveDataDir(env));
    expect(getDataDir(env)).toBe('/tmp/memphis-parity');
  });

  it('getDataDir → bridgeResolveDataDir for default (~/.memphis)', () => {
    // HOME is set in the bridge env so the result resolves to a
    // concrete path. The test asserts equality, not the literal — the
    // bridge's `expand_home` is the source of truth.
    const env = {} as NodeJS.ProcessEnv;
    expect(getDataDir(env)).toBe(bridgeResolveDataDir(env));
    expect(getDataDir(env).endsWith('/.memphis')).toBe(true);
  });

  it('getChainPath(undefined) → bridgeResolveChainsDir', () => {
    const env = { MEMPHIS_DATA_DIR: '/tmp/memphis-parity' } as NodeJS.ProcessEnv;
    expect(getChainPath(undefined, env)).toBe(bridgeResolveChainsDir(env));
    expect(getChainPath(undefined, env)).toBe('/tmp/memphis-parity/chains');
  });

  it('getChainPath(name) → bridgeResolveChainPath(name)', () => {
    const env = { MEMPHIS_DATA_DIR: '/tmp/memphis-parity' } as NodeJS.ProcessEnv;
    for (const name of ['journal', 'cases', 'patterns', 'reflections']) {
      expect(getChainPath(name, env)).toBe(bridgeResolveChainPath(name, env));
    }
  });

  it('normalizeChainName(alias) → bridgeNormalizeChainName(alias)', () => {
    // Both sides canonicalize the same way: singular → plural.
    for (const [alias, canonical] of [
      ['decision', 'decisions'],
      ['case', 'cases'],
      ['pattern', 'patterns'],
      ['reflection', 'reflections'],
      ['journal', 'journal'], // already canonical, passes through
    ]) {
      expect(normalizeChainName(alias)).toBe(canonical);
      expect(bridgeNormalizeChainName(alias)).toBe(canonical);
    }
  });

  it('normalizeChainName(undefined) returns undefined without touching bridge', () => {
    // The bridge can't be called with undefined — the TS wrapper short-
    // circuits. Verify the TS wrapper preserves that behavior.
    expect(normalizeChainName(undefined)).toBeUndefined();
  });

  it('chain alias canonicalization round-trips through bridge resolve', () => {
    const env = { MEMPHIS_DATA_DIR: '/tmp/memphis-parity' } as NodeJS.ProcessEnv;
    // `decision` → `decisions` for write paths, but reads still see
    // both directories. The bridge resolves the canonical form; the TS
    // wrapper preserves the alias mirror via getReadableChainNames.
    expect(getChainPath('decision', env)).toBe('/tmp/memphis-parity/chains/decisions');
    expect(bridgeResolveChainPath('decision', env)).toBe('/tmp/memphis-parity/chains/decisions');
  });
});
