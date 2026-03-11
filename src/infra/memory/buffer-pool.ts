export interface BufferPoolOptions {
  maxBytes?: number;
  bucketSizes?: number[];
}

export interface BufferPoolStats {
  maxBytes: number;
  usedBytes: number;
  pooledBytes: number;
  allocCount: number;
  reuseCount: number;
  releaseCount: number;
  misses: number;
}

export class BufferPool {
  private readonly maxBytes: number;
  private readonly bucketSizes: number[];
  private readonly buckets = new Map<number, Buffer[]>();

  private usedBytes = 0;
  private allocCount = 0;
  private reuseCount = 0;
  private releaseCount = 0;
  private misses = 0;

  constructor(options: BufferPoolOptions = {}) {
    this.maxBytes = Math.max(1024, options.maxBytes ?? 10 * 1024 * 1024);
    this.bucketSizes = (options.bucketSizes ?? [256, 512, 1024, 4096, 16384, 65536, 262144])
      .filter((size) => size > 0)
      .sort((a, b) => a - b);
  }

  private bucketFor(size: number): number {
    for (const candidate of this.bucketSizes) {
      if (candidate >= size) return candidate;
    }
    return size;
  }

  acquire(size: number): Buffer {
    const bucket = this.bucketFor(Math.max(1, size));
    const list = this.buckets.get(bucket);

    if (list && list.length > 0) {
      const buffer = list.pop() as Buffer;
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

    const pooledBytes = this.getPooledBytes();
    if (pooledBytes + bucket > this.maxBytes) {
      this.misses += 1;
      return;
    }

    if (!this.buckets.has(bucket)) {
      this.buckets.set(bucket, []);
    }

    buffer.fill(0);
    this.buckets.get(bucket)!.push(buffer);
  }

  private getPooledBytes(): number {
    let total = 0;
    for (const [size, list] of this.buckets) {
      total += size * list.length;
    }
    return total;
  }

  getStats(): BufferPoolStats {
    return {
      maxBytes: this.maxBytes,
      usedBytes: this.usedBytes,
      pooledBytes: this.getPooledBytes(),
      allocCount: this.allocCount,
      reuseCount: this.reuseCount,
      releaseCount: this.releaseCount,
      misses: this.misses,
    };
  }
}
