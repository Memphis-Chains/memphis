import { describe, expect, it } from 'vitest';

import {
  hasRequiredBridgeExports,
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
