export interface QueryBatcherOptions {
  maxBatchSize?: number;
}

export interface QueryBatcherStats {
  reads: number;
  writes: number;
  readBatches: number;
  writeBatches: number;
  maxBatchSize: number;
}

type ReadTask<T> = () => Promise<T> | T;
type WriteTask<T> = () => Promise<T> | T;

export class QueryBatcher {
  private readonly maxBatchSize: number;
  private readQueue: Array<() => Promise<void>> = [];
  private writeQueue: Array<() => Promise<void>> = [];

  private reads = 0;
  private writes = 0;
  private readBatches = 0;
  private writeBatches = 0;
  private flushChain: Promise<void> = Promise.resolve();

  constructor(options: QueryBatcherOptions = {}) {
    this.maxBatchSize = Math.max(1, options.maxBatchSize ?? 10);
  }

  enqueueRead<T>(task: ReadTask<T>): Promise<T> {
    this.reads += 1;
    return new Promise<T>((resolve, reject) => {
      this.readQueue.push(async () => {
        try {
          resolve(await task());
        } catch (error) {
          reject(error);
        }
      });
    });
  }

  enqueueWrite<T>(task: WriteTask<T>): Promise<T> {
    this.writes += 1;
    return new Promise<T>((resolve, reject) => {
      this.writeQueue.push(async () => {
        try {
          resolve(await task());
        } catch (error) {
          reject(error);
        }
      });
    });
  }

  async flush(): Promise<void> {
    const run = this.flushChain.then(async () => {
      await this.flushInternal();
    });
    this.flushChain = run.catch(() => undefined);
    await run;
  }

  private async flushInternal(): Promise<void> {
    while (this.readQueue.length > 0) {
      const batch = this.readQueue.splice(0, this.maxBatchSize);
      this.readBatches += 1;
      await Promise.all(batch.map((task) => task()));
    }

    while (this.writeQueue.length > 0) {
      const batch = this.writeQueue.splice(0, this.maxBatchSize);
      this.writeBatches += 1;
      for (const task of batch) {
        await task();
      }
    }
  }

  getStats(): QueryBatcherStats {
    return {
      reads: this.reads,
      writes: this.writes,
      readBatches: this.readBatches,
      writeBatches: this.writeBatches,
      maxBatchSize: this.maxBatchSize,
    };
  }
}
