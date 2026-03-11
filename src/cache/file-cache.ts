// File Content Cache - Reduces filesystem reads
// Caches frequently accessed memory files

import * as fs from 'fs/promises';

interface FileCacheEntry {
  content: string;
  mtime: number; // Last modified time
  size: number;
}

export class FileCache {
  private cache = new Map<string, FileCacheEntry>();
  private maxSize: number; // Max cache size in bytes
  private currentSize: number = 0;

  constructor(maxSizeBytes: number = 50 * 1024 * 1024) {
    // 50MB default
    this.maxSize = maxSizeBytes;
  }

  /**
   * Read file with caching
   */
  async read(filePath: string): Promise<string> {
    // Check cache
    const cached = this.cache.get(filePath);

    if (cached) {
      // Check if file modified since cache
      const stat = await fs.stat(filePath);

      if (stat.mtimeMs === cached.mtime) {
        // Cache hit!
        return cached.content;
      }

      // File modified, evict old entry
      this.evict(filePath);
    }

    // Cache miss - read file
    const content = await fs.readFile(filePath, 'utf-8');
    const stat = await fs.stat(filePath);

    // Store in cache
    const size = Buffer.byteLength(content, 'utf-8');

    // Evict if needed
    while (this.currentSize + size > this.maxSize && this.cache.size > 0) {
      this.evictOldest();
    }

    this.cache.set(filePath, {
      content,
      mtime: stat.mtimeMs,
      size,
    });

    this.currentSize += size;

    return content;
  }

  /**
   * Invalidate specific file
   */
  invalidate(filePath: string): void {
    this.evict(filePath);
  }

  /**
   * Invalidate all files matching pattern
   */
  invalidatePattern(pattern: RegExp): number {
    let count = 0;

    for (const filePath of this.cache.keys()) {
      if (pattern.test(filePath)) {
        this.evict(filePath);
        count++;
      }
    }

    return count;
  }

  /**
   * Get cache stats
   */
  stats(): {
    files: number;
    sizeBytes: number;
    sizeMB: number;
    utilization: number;
  } {
    return {
      files: this.cache.size,
      sizeBytes: this.currentSize,
      sizeMB: this.currentSize / (1024 * 1024),
      utilization: (this.currentSize / this.maxSize) * 100,
    };
  }

  /**
   * Clear all cache
   */
  clear(): void {
    this.cache.clear();
    this.currentSize = 0;
  }

  /**
   * Evict specific file
   */
  private evict(filePath: string): void {
    const entry = this.cache.get(filePath);

    if (entry) {
      this.currentSize -= entry.size;
      this.cache.delete(filePath);
    }
  }

  /**
   * Evict oldest file (LRU based on file mtime)
   */
  private evictOldest(): void {
    let oldest: string | null = null;
    let oldestTime = Infinity;

    for (const [filePath, entry] of this.cache.entries()) {
      if (entry.mtime < oldestTime) {
        oldestTime = entry.mtime;
        oldest = filePath;
      }
    }

    if (oldest) {
      this.evict(oldest);
    }
  }
}

// Global file cache instance (50MB)
export const fileCache = new FileCache(50 * 1024 * 1024);
