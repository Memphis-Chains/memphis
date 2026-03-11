// Cache Manager - Coordinates all cache layers
// Query cache + File cache + Embedding cache

import { FileCache, fileCache } from './file-cache.js';
import { QueryCache, queryCache } from './query-cache.js';

export class CacheManager {
  constructor(
    public readonly query: QueryCache = queryCache,
    public readonly file: FileCache = fileCache,
  ) {}

  /**
   * Prune all caches (remove expired/old entries)
   */
  prune(): {
    queriesPruned: number;
    filesEvicted: number;
  } {
    const queriesPruned = this.query.prune();

    // File cache doesn't have prune (uses LRU + size-based eviction)
    return {
      queriesPruned,
      filesEvicted: 0,
    };
  }

  /**
   * Clear all caches
   */
  clear(): void {
    this.query.clear();
    this.file.clear();
  }

  /**
   * Get comprehensive stats
   */
  stats(): {
    query: ReturnType<QueryCache['stats']>;
    file: ReturnType<FileCache['stats']>;
  } {
    return {
      query: this.query.stats(),
      file: this.file.stats(),
    };
  }

  /**
   * Warm up caches with frequently accessed files
   */
  async warmup(filePaths: string[]): Promise<void> {
    await Promise.all(
      filePaths.map(async (path) => {
        try {
          await this.file.read(path);
        } catch {
          // File doesn't exist or can't be read - ignore
        }
      }),
    );
  }
}

// Global cache manager
export const cacheManager = new CacheManager();
