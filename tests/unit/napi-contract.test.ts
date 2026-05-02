import { describe, expect, it } from 'vitest';

import {
  detectPlatformTriple,
  hasRequiredBridgeExports,
  platformPackageName,
  resolveBridgeContract,
  type BridgeAliasMap,
} from '../../src/infra/storage/napi-contract.js';

describe('napi-contract helpers', () => {
  it('prefers canonical snake_case exports when present', () => {
    const aliases = {
      embed_store: ['embed_store', 'embedStore'],
    } satisfies BridgeAliasMap<'embed_store'>;

    const resolution = resolveBridgeContract(
      {
        embed_store: () => 'snake',
        embedStore: () => 'camel',
      },
      aliases,
    );

    expect(resolution.bridgeLoaded).toBe(true);
    expect(resolution.missing).toEqual([]);
    expect(resolution.legacyAliasesUsed).toEqual({});
    expect(resolution.resolved.embed_store?.()).toBe('snake');
  });

  it('records legacy alias usage when canonical export is absent', () => {
    const aliases = {
      embed_store: ['embed_store', 'embedStore'],
      embed_reset: ['embed_reset', 'embedReset'],
    } satisfies BridgeAliasMap<'embed_store' | 'embed_reset'>;

    const resolution = resolveBridgeContract(
      {
        embedStore: () => 'camel',
      },
      aliases,
    );

    expect(resolution.bridgeLoaded).toBe(true);
    expect(resolution.legacyAliasesUsed).toEqual({ embed_store: 'embedStore' });
    expect(resolution.missing).toEqual(['embed_reset']);
    expect(hasRequiredBridgeExports(resolution, ['embed_store'])).toBe(true);
    expect(hasRequiredBridgeExports(resolution, ['embed_store', 'embed_reset'])).toBe(false);
  });
});

describe('detectPlatformTriple', () => {
  function fakeProcess(
    platform: NodeJS.Platform,
    arch: string,
    glibcVersionRuntime?: string,
  ): typeof process {
    return {
      platform,
      arch,
      report: {
        getReport: () => ({
          header: glibcVersionRuntime !== undefined ? { glibcVersionRuntime } : {},
        }),
      },
      cwd: () => '/tmp',
    } as unknown as typeof process;
  }

  it('returns linux-x64-gnu for glibc Linux on x64', () => {
    expect(detectPlatformTriple(fakeProcess('linux', 'x64', '2.39'))).toBe('linux-x64-gnu');
  });

  it('returns linux-arm64-gnu for glibc Linux on arm64', () => {
    expect(detectPlatformTriple(fakeProcess('linux', 'arm64', '2.39'))).toBe('linux-arm64-gnu');
  });

  it('returns null for musl Linux (no prebuild yet)', () => {
    // glibcVersionRuntime undefined ⇒ musl/Alpine.
    expect(detectPlatformTriple(fakeProcess('linux', 'x64'))).toBe(null);
  });

  it('returns darwin-x64 for macOS Intel', () => {
    expect(detectPlatformTriple(fakeProcess('darwin', 'x64'))).toBe('darwin-x64');
  });

  it('returns darwin-arm64 for Apple Silicon', () => {
    expect(detectPlatformTriple(fakeProcess('darwin', 'arm64'))).toBe('darwin-arm64');
  });

  it('returns null for Windows (no native prebuild — operators use WSL2)', () => {
    expect(detectPlatformTriple(fakeProcess('win32', 'x64'))).toBe(null);
  });

  it('returns null for unsupported arch on supported platform', () => {
    // e.g. armv7 / mips — out of matrix
    expect(detectPlatformTriple(fakeProcess('linux', 'arm', '2.39'))).toBe(null);
  });
});

describe('platformPackageName', () => {
  it('builds npm scope/name for each supported triple', () => {
    expect(platformPackageName('linux-x64-gnu')).toBe('@memphis-chains/memphis-linux-x64-gnu');
    expect(platformPackageName('linux-arm64-gnu')).toBe('@memphis-chains/memphis-linux-arm64-gnu');
    expect(platformPackageName('darwin-x64')).toBe('@memphis-chains/memphis-darwin-x64');
    expect(platformPackageName('darwin-arm64')).toBe('@memphis-chains/memphis-darwin-arm64');
  });
});
