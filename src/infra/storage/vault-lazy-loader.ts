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
  private readonly decryptedCache = new Map<string, TDecrypted>();
  private readonly decrypt: (encrypted: TEncrypted) => Promise<TDecrypted> | TDecrypted;
  private readonly maxDecryptedCache: number;

  private decryptOps = 0;
  private cacheHits = 0;
  private cacheMisses = 0;

  constructor(options: VaultLazyLoaderOptions<TEncrypted, TDecrypted>) {
    this.decrypt = options.decrypt;
    this.maxDecryptedCache = Math.max(1, options.maxDecryptedCache ?? 100);
  }

  private touchCache(id: string, decrypted: TDecrypted): void {
    if (this.decryptedCache.has(id)) {
      this.decryptedCache.delete(id);
    }

    this.decryptedCache.set(id, decrypted);

    if (this.decryptedCache.size > this.maxDecryptedCache) {
      const oldestKey = this.decryptedCache.keys().next().value as string | undefined;
      if (oldestKey) {
        this.decryptedCache.delete(oldestKey);
      }
    }
  }

  put(id: string, encrypted: TEncrypted): void {
    this.encrypted.set(id, encrypted);
    this.decryptedCache.delete(id);
  }

  async get(id: string): Promise<TDecrypted | undefined> {
    const cached = this.decryptedCache.get(id);
    if (cached !== undefined) {
      this.cacheHits += 1;
      this.touchCache(id, cached);
      return cached;
    }

    this.cacheMisses += 1;

    const encrypted = this.encrypted.get(id);
    if (encrypted === undefined) {
      return undefined;
    }

    const decrypted = await this.decrypt(encrypted);
    this.decryptOps += 1;
    this.touchCache(id, decrypted);
    return decrypted;
  }

  delete(id: string): boolean {
    const deleted = this.encrypted.delete(id);
    this.decryptedCache.delete(id);
    return deleted;
  }

  getStats(): VaultLazyStats {
    let encryptedBytes = 0;
    for (const value of this.encrypted.values()) {
      encryptedBytes += roughSize(value);
    }

    let decryptedBytes = 0;
    for (const value of this.decryptedCache.values()) {
      decryptedBytes += roughSize(value);
    }

    const totalCacheReads = this.cacheHits + this.cacheMisses;

    return {
      encryptedItems: this.encrypted.size,
      decryptedCacheSize: this.decryptedCache.size,
      decryptOps: this.decryptOps,
      estimatedEncryptedBytes: encryptedBytes,
      estimatedDecryptedBytes: decryptedBytes,
      decryptCacheHitRate: totalCacheReads === 0 ? 0 : this.cacheHits / totalCacheReads,
    };
  }
}

function roughSize(value: unknown): number {
  try {
    return Buffer.byteLength(JSON.stringify(value), 'utf8');
  } catch {
    return 0;
  }
}
