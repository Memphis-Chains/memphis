export interface ChainCacheOptions {
  maxBlocks?: number;
}

export interface ChainCacheStats {
  size: number;
  maxBlocks: number;
  hits: number;
  misses: number;
  writes: number;
  invalidations: number;
  hitRate: number;
}

export type ChainBlockRecord = Record<string, unknown>;

export class ChainCache {
  private readonly maxBlocks: number;
  private readonly blocks = new Map<string, ChainBlockRecord>();
  private hits = 0;
  private misses = 0;
  private writes = 0;
  private invalidations = 0;

  constructor(options: ChainCacheOptions = {}) {
    this.maxBlocks = Math.max(1, options.maxBlocks ?? 1000);
  }

  private makeKey(chain: string, index: number): string {
    return `${chain}:${index}`;
  }

  get(chain: string, index: number): ChainBlockRecord | undefined {
    const key = this.makeKey(chain, index);
    const value = this.blocks.get(key);

    if (value) {
      this.hits += 1;
      this.blocks.delete(key);
      this.blocks.set(key, value);
      return value;
    }

    this.misses += 1;
    return undefined;
  }

  set(chain: string, index: number, value: ChainBlockRecord): void {
    const key = this.makeKey(chain, index);

    if (this.blocks.has(key)) {
      this.blocks.delete(key);
    }

    this.blocks.set(key, value);
    this.writes += 1;

    if (this.blocks.size > this.maxBlocks) {
      const oldestKey = this.blocks.keys().next().value as string | undefined;
      if (oldestKey) {
        this.blocks.delete(oldestKey);
      }
    }
  }

  invalidateChain(chain: string): number {
    let removed = 0;
    for (const key of this.blocks.keys()) {
      if (key.startsWith(`${chain}:`)) {
        this.blocks.delete(key);
        removed += 1;
      }
    }

    if (removed > 0) {
      this.invalidations += 1;
    }

    return removed;
  }

  invalidateBlock(chain: string, index: number): boolean {
    const deleted = this.blocks.delete(this.makeKey(chain, index));
    if (deleted) {
      this.invalidations += 1;
    }
    return deleted;
  }

  clear(): void {
    if (this.blocks.size > 0) {
      this.blocks.clear();
      this.invalidations += 1;
    }
  }

  getStats(): ChainCacheStats {
    const totalReads = this.hits + this.misses;
    return {
      size: this.blocks.size,
      maxBlocks: this.maxBlocks,
      hits: this.hits,
      misses: this.misses,
      writes: this.writes,
      invalidations: this.invalidations,
      hitRate: totalReads === 0 ? 0 : this.hits / totalReads,
    };
  }
}
