export interface BufferPoolOptions {
  maxBytes?: number;
  bucketSizes?: number[];
  maxBuffersPerBucket?: number;
}

export interface BufferPoolStats {
  maxBytes: number;
  usedBytes: number;
  pooledBytes: number;
  allocCount: number;
  reuseCount: number;
  releaseCount: number;
  misses: number;
  rssBytes: number;
  heapUsedBytes: number;
}

export class BufferPool {
  private readonly maxBytes: number;
  private readonly bucketSizes: number[];
  private readonly maxBuffersPerBucket: number;
  private readonly buckets = new Map<number, Buffer[]>();

  private usedBytes = 0;
  private pooledBytes = 0;
  private allocCount = 0;
  private reuseCount = 0;
  private releaseCount = 0;
  private misses = 0;

  constructor(options: BufferPoolOptions = {}) {
    this.maxBytes = Math.max(1024, options.maxBytes ?? 4 * 1024 * 1024);
    this.bucketSizes = (options.bucketSizes ?? [256, 512, 1024, 4096, 16384, 65536, 262144])
      .filter((size) => size > 0)
      .sort((a, b) => a - b);
    this.maxBuffersPerBucket = Math.max(1, options.maxBuffersPerBucket ?? 64);
  }

  private bucketFor(size: number): number {
    let lo = 0;
    let hi = this.bucketSizes.length - 1;
    let best = -1;

    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      const candidate = this.bucketSizes[mid]!;
      if (candidate >= size) {
        best = candidate;
        hi = mid - 1;
      } else {
        lo = mid + 1;
      }
    }

    return best > 0 ? best : size;
  }

  acquire(size: number): Buffer {
    const bucket = this.bucketFor(Math.max(1, size));
    const list = this.buckets.get(bucket);

    if (list && list.length > 0) {
      const buffer = list.pop() as Buffer;
      this.pooledBytes = Math.max(0, this.pooledBytes - buffer.byteLength);
      this.usedBytes += buffer.byteLength;
      this.reuseCount += 1;
      return buffer;
    }

    this.allocCount += 1;
    this.usedBytes += bucket;
    return Buffer.allocUnsafe(bucket);
  }

  release(buffer: Buffer): void {
    const bucket = buffer.byteLength;
    this.releaseCount += 1;
    this.usedBytes = Math.max(0, this.usedBytes - bucket);

    if (this.pooledBytes + bucket > this.maxBytes) {
      this.misses += 1;
      return;
    }

    let list = this.buckets.get(bucket);
    if (!list) {
      list = [];
      this.buckets.set(bucket, list);
    }

    if (list.length >= this.maxBuffersPerBucket) {
      this.misses += 1;
      return;
    }

    // Fast reset while avoiding full-page overwrite overhead.
    buffer.subarray(0, Math.min(64, buffer.length)).fill(0);
    list.push(buffer);
    this.pooledBytes += bucket;

    if (this.pooledBytes > this.maxBytes) {
      this.trim();
    }
  }

  trim(targetBytes = Math.floor(this.maxBytes * 0.75)): void {
    if (this.pooledBytes <= targetBytes) return;

    const bucketsDesc = [...this.buckets.keys()].sort((a, b) => b - a);
    for (const bucketSize of bucketsDesc) {
      const list = this.buckets.get(bucketSize);
      if (!list) continue;

      while (list.length > 0 && this.pooledBytes > targetBytes) {
        list.pop();
        this.pooledBytes = Math.max(0, this.pooledBytes - bucketSize);
      }

      if (list.length === 0) {
        this.buckets.delete(bucketSize);
      }

      if (this.pooledBytes <= targetBytes) {
        break;
      }
    }
  }

  getStats(): BufferPoolStats {
    const processMem = process.memoryUsage();
    return {
      maxBytes: this.maxBytes,
      usedBytes: this.usedBytes,
      pooledBytes: this.pooledBytes,
      allocCount: this.allocCount,
      reuseCount: this.reuseCount,
      releaseCount: this.releaseCount,
      misses: this.misses,
      rssBytes: processMem.rss,
      heapUsedBytes: processMem.heapUsed,
    };
  }
}
