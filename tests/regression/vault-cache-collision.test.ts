import { describe, expect, it } from 'vitest';
import { VaultLazyLoader } from '../../src/infra/storage/vault-lazy-loader.js';

describe('VaultLazyLoader cache key regression', () => {
  it('uses full id for cache keys to avoid hash collisions', async () => {
    let decryptCalls = 0;
    const loader = new VaultLazyLoader<string, string>({
      decrypt: (cipher) => {
        decryptCalls += 1;
        return `dec:${cipher}`;
      },
    });

    // These collide under the old Java-style 31 hash implementation.
    loader.put('Aa', 'first');
    loader.put('BB', 'second');

    const first = await loader.get('Aa');
    const second = await loader.get('BB');

    expect(first).toBe('dec:first');
    expect(second).toBe('dec:second');
    expect(decryptCalls).toBe(2);
  });
});
