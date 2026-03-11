import { ChainCache } from '../cache/chain-cache.js';

export interface VaultLazyLoaderOptions<TEncrypted, TDecrypted> {
  decrypt: (encrypted: TEncrypted) => Promise<TDecrypted> | TDecrypted;
  maxDecryptedCache?: number;
}

export interface VaultLazyStats {
  encryptedItems: number;
  decryptedCacheSize: number;
  decryptOps: number;
  estimatedEncryptedBytes: number;
  estimatedDecryptedBytes: number;
  decryptCacheHitRate: number;
}

export class VaultLazyLoader<TEncrypted, TDecrypted> {
  private readonly encrypted = new Map<string, TEncrypted>();
  private readonly decryptedCache: ChainCache;
  private readonly decrypt: (encrypted: TEncrypted) => Promise<TDecrypted> | TDecrypted;
  private decryptOps = 0;

  constructor(options: VaultLazyLoaderOptions<TEncrypted, TDecrypted>) {
    this.decrypt = options.decrypt;
    this.decryptedCache = new ChainCache({ maxBlocks: options.maxDecryptedCache ?? 100 });
  }

  put(id: string, encrypted: TEncrypted): void {
    this.encrypted.set(id, encrypted);
    this.decryptedCache.invalidateBlock('vault', this.hashId(id));
  }

  async get(id: string): Promise<TDecrypted | undefined> {
    const cacheKey = this.hashId(id);
    const cached = this.decryptedCache.get('vault', cacheKey);
    if (cached) {
      return cached.value as TDecrypted;
    }

    const encrypted = this.encrypted.get(id);
    if (!encrypted) {
      return undefined;
    }

    const decrypted = await this.decrypt(encrypted);
    this.decryptOps += 1;
    this.decryptedCache.set('vault', cacheKey, { value: decrypted });
    return decrypted;
  }

  delete(id: string): boolean {
    const deleted = this.encrypted.delete(id);
    this.decryptedCache.invalidateBlock('vault', this.hashId(id));
    return deleted;
  }

  getStats(): VaultLazyStats {
    const cacheStats = this.decryptedCache.getStats();
    let encryptedBytes = 0;
    for (const value of this.encrypted.values()) {
      encryptedBytes += roughSize(value);
    }

    return {
      encryptedItems: this.encrypted.size,
      decryptedCacheSize: cacheStats.size,
      decryptOps: this.decryptOps,
      estimatedEncryptedBytes: encryptedBytes,
      estimatedDecryptedBytes: cacheStats.size * 1024,
      decryptCacheHitRate: cacheStats.hitRate,
    };
  }

  private hashId(id: string): number {
    let hash = 0;
    for (let i = 0; i < id.length; i += 1) {
      hash = (hash * 31 + id.charCodeAt(i)) >>> 0;
    }
    return hash;
  }
}

function roughSize(value: unknown): number {
  try {
    return Buffer.byteLength(JSON.stringify(value), 'utf8');
  } catch {
    return 0;
  }
}
