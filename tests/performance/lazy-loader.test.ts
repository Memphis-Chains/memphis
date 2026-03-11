import { describe, expect, it } from 'vitest';
import { VaultLazyLoader } from '../../src/infra/storage/vault-lazy-loader.js';

describe('VaultLazyLoader', () => {
  it('decrypts on demand and caches decrypted values', async () => {
    let decryptCalls = 0;
    const loader = new VaultLazyLoader<string, string>({
      decrypt: (cipher) => {
        decryptCalls += 1;
        return cipher.replace('enc:', 'plain:');
      },
      maxDecryptedCache: 100,
    });

    loader.put('a', 'enc:hello');
    const first = await loader.get('a');
    const second = await loader.get('a');

    expect(first).toBe('plain:hello');
    expect(second).toBe('plain:hello');
    expect(decryptCalls).toBe(1);

    const stats = loader.getStats();
    expect(stats.decryptedCacheSize).toBe(1);
    expect(stats.decryptCacheHitRate).toBeGreaterThan(0);
  });
});
