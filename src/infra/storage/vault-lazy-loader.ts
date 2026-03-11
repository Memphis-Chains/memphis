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
  private readonly encryptedSizes = new Map<string, number>();
  private readonly decryptedCache = new Map<string, TDecrypted>();
  private readonly decryptedSizes = new Map<string, number>();
  private readonly decrypt: (encrypted: TEncrypted) => Promise<TDecrypted> | TDecrypted;
  private readonly maxDecryptedCache: number;

  private decryptOps = 0;
  private cacheHits = 0;
  private cacheMisses = 0;
  private estimatedEncryptedBytes = 0;
  private estimatedDecryptedBytes = 0;

  constructor(options: VaultLazyLoaderOptions<TEncrypted, TDecrypted>) {
    this.decrypt = options.decrypt;
    this.maxDecryptedCache = Math.max(1, options.maxDecryptedCache ?? 100);
  }

  private touchCache(id: string, decrypted: TDecrypted): void {
    const existingSize = this.decryptedSizes.get(id);
    if (existingSize !== undefined) {
      this.decryptedCache.delete(id);
      this.decryptedSizes.delete(id);
      this.estimatedDecryptedBytes = Math.max(0, this.estimatedDecryptedBytes - existingSize);
    }

    this.decryptedCache.set(id, decrypted);
    const nextSize = roughSize(decrypted);
    this.decryptedSizes.set(id, nextSize);
    this.estimatedDecryptedBytes += nextSize;

    if (this.decryptedCache.size > this.maxDecryptedCache) {
      const oldestKey = this.decryptedCache.keys().next().value as string | undefined;
      if (oldestKey) {
        this.decryptedCache.delete(oldestKey);
        const oldestSize = this.decryptedSizes.get(oldestKey) ?? 0;
        this.decryptedSizes.delete(oldestKey);
        this.estimatedDecryptedBytes = Math.max(0, this.estimatedDecryptedBytes - oldestSize);
      }
    }
  }

  put(id: string, encrypted: TEncrypted): void {
    const oldEncryptedSize = this.encryptedSizes.get(id);
    if (oldEncryptedSize !== undefined) {
      this.estimatedEncryptedBytes = Math.max(0, this.estimatedEncryptedBytes - oldEncryptedSize);
    }

    this.encrypted.set(id, encrypted);
    const nextEncryptedSize = roughSize(encrypted);
    this.encryptedSizes.set(id, nextEncryptedSize);
    this.estimatedEncryptedBytes += nextEncryptedSize;

    const oldDecryptedSize = this.decryptedSizes.get(id);
    if (oldDecryptedSize !== undefined) {
      this.estimatedDecryptedBytes = Math.max(0, this.estimatedDecryptedBytes - oldDecryptedSize);
      this.decryptedSizes.delete(id);
    }
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
    const encryptedSize = this.encryptedSizes.get(id);
    if (encryptedSize !== undefined) {
      this.estimatedEncryptedBytes = Math.max(0, this.estimatedEncryptedBytes - encryptedSize);
      this.encryptedSizes.delete(id);
    }

    const decryptedSize = this.decryptedSizes.get(id);
    if (decryptedSize !== undefined) {
      this.estimatedDecryptedBytes = Math.max(0, this.estimatedDecryptedBytes - decryptedSize);
      this.decryptedSizes.delete(id);
    }
    this.decryptedCache.delete(id);
    return deleted;
  }

  getStats(): VaultLazyStats {
    const totalCacheReads = this.cacheHits + this.cacheMisses;

    return {
      encryptedItems: this.encrypted.size,
      decryptedCacheSize: this.decryptedCache.size,
      decryptOps: this.decryptOps,
      estimatedEncryptedBytes: this.estimatedEncryptedBytes,
      estimatedDecryptedBytes: this.estimatedDecryptedBytes,
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
