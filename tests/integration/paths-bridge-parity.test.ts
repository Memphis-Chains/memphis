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
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { getChainPath, getDataDir, normalizeChainName } from '../../src/config/paths.js';
import {
  __resetPathsBridgeCacheForTests,
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

  it('absolute MEMPHIS_DATA_DIR works when HOME lookup is unavailable', () => {
    // Codex R2 #436: when os.homedir() throws/empty AND no absolute
    // override, the bridge must fail loud rather than silently
    // resolve `~/.memphis` against cwd. But absolute MEMPHIS_DATA_DIR
    // doesn't need home expansion — that path must keep working on
    // passwd-less service users.
    const env = { MEMPHIS_DATA_DIR: '/var/memphis-svc' } as NodeJS.ProcessEnv;
    expect(getDataDir(env)).toBe('/var/memphis-svc');
  });

  it('subsequent calls re-resolve after RUST_CHAIN_BRIDGE_PATH changes (no cache lock-in)', () => {
    // Codex R5 #436: getDataDir() is called at module-import time
    // (src/config/index.ts:16) before `.env` loads
    // RUST_CHAIN_BRIDGE_PATH. The cache used to lock in the FIRST
    // resolution, so the override never took effect even after `.env`
    // was read. Fix keys cache by computed binary path so post-`.env`
    // calls re-resolve.
    //
    // Compute the override from import.meta.url so the test works on
    // any checkout root (CI uses /home/runner/work/...). Both calls
    // resolve to a real binary so the bridge actually loads — the
    // assertion isn't about the path value, it's about the cache not
    // locking in the no-override result before the override appears.
    const here = fileURLToPath(import.meta.url);
    const repoRoot = resolve(here, '..', '..', '..');
    const napiDir = resolve(repoRoot, 'crates', 'memphis-napi');
    __resetPathsBridgeCacheForTests();
    const previousOverride = process.env.RUST_CHAIN_BRIDGE_PATH;
    delete process.env.RUST_CHAIN_BRIDGE_PATH;
    const before = getDataDir({ MEMPHIS_DATA_DIR: '/tmp/before-env-load' } as NodeJS.ProcessEnv);
    expect(before).toBe('/tmp/before-env-load');
    // Now set override (simulates .env loading after import-time call)
    process.env.RUST_CHAIN_BRIDGE_PATH = napiDir;
    const after = getDataDir({ MEMPHIS_DATA_DIR: '/tmp/after-env-load' } as NodeJS.ProcessEnv);
    expect(after).toBe('/tmp/after-env-load');
    if (previousOverride === undefined) delete process.env.RUST_CHAIN_BRIDGE_PATH;
    else process.env.RUST_CHAIN_BRIDGE_PATH = previousOverride;
  });
});
