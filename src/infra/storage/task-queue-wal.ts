import {
  closeSync,
  existsSync,
  fdatasyncSync,
  fstatSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  statSync,
  truncateSync,
  unlinkSync,
  writeSync,
} from 'node:fs';
import { dirname, resolve } from 'node:path';

type QueueMode = 'financial' | 'standard';

export interface TaskQueueWalOptions {
  walPath: string;
  mode?: QueueMode;
  maxWalBytes?: number;
  lockPath?: string;
  lockTimeoutMs?: number;
  faultInject?: string;
}

export interface WalRecord {
  payload: string;
  offset: number;
  length: number;
}

const CRC32C_TABLE = buildCrc32cTable();
const DEFAULT_MAX_WAL_BYTES = 10 * 1024 * 1024;

function sleepMs(ms: number): void {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    // intentional busy-wait for lock retry in short critical sections
  }
}

function buildCrc32cTable(): Uint32Array {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i += 1) {
    let crc = i;
    for (let j = 0; j < 8; j += 1) {
      crc = (crc & 1) !== 0 ? (crc >>> 1) ^ 0x82f63b78 : crc >>> 1;
    }
    table[i] = crc >>> 0;
  }
  return table;
}

function crc32c(bytes: Buffer): number {
  let crc = 0xffffffff;
  for (let i = 0; i < bytes.length; i += 1) {
    const index = (crc ^ bytes[i]!) & 0xff;
    crc = (crc >>> 8) ^ CRC32C_TABLE[index]!;
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function encodeRecord(payload: string): Buffer {
  const payloadBytes = Buffer.from(payload, 'utf8');
  const out = Buffer.allocUnsafe(4 + payloadBytes.length + 4);
  out.writeUInt32BE(payloadBytes.length, 0);
  payloadBytes.copy(out, 4);
  out.writeUInt32BE(crc32c(payloadBytes), 4 + payloadBytes.length);
  return out;
}

function parseRecords(buffer: Buffer): { records: WalRecord[]; validBytes: number } {
  const records: WalRecord[] = [];
  let offset = 0;
  while (offset + 8 <= buffer.length) {
    const payloadLen = buffer.readUInt32BE(offset);
    const payloadStart = offset + 4;
    const payloadEnd = payloadStart + payloadLen;
    const crcEnd = payloadEnd + 4;

    if (crcEnd > buffer.length) break;

    const payload = buffer.subarray(payloadStart, payloadEnd);
    const expectedCrc = buffer.readUInt32BE(payloadEnd);
    const actualCrc = crc32c(payload);
    if (expectedCrc !== actualCrc) {
      break;
    }

    records.push({
      payload: payload.toString('utf8'),
      offset,
      length: crcEnd - offset,
    });
    offset = crcEnd;
  }

  return { records, validBytes: offset };
}

export class TaskQueueWal {
  private readonly walPath: string;
  private readonly lockPath: string;
  private readonly mode: QueueMode;
  private readonly maxWalBytes: number;
  private readonly lockTimeoutMs: number;
  private readonly faultInject: string | undefined;

  constructor(options: TaskQueueWalOptions) {
    this.walPath = resolve(options.walPath);
    this.lockPath = resolve(options.lockPath ?? `${this.walPath}.lock`);
    this.mode = options.mode ?? 'financial';
    this.maxWalBytes = options.maxWalBytes ?? DEFAULT_MAX_WAL_BYTES;
    this.lockTimeoutMs = options.lockTimeoutMs ?? 2000;
    this.faultInject = options.faultInject ?? process.env.MEMPHIS_FAULT_INJECT;

    mkdirSync(dirname(this.walPath), { recursive: true });
    this.ensureActiveWal();
  }

  public enqueue(task: unknown): WalRecord {
    const payload = JSON.stringify(task);
    const encoded = encodeRecord(payload);

    return this.withLock(() => {
      this.rotateIfNeeded(encoded.length);
      const fd = openSync(this.walPath, 'a', 0o600);
      try {
        const offset = fstatSync(fd).size;
        writeSync(fd, encoded, 0, encoded.length, offset);
        if (this.mode === 'financial') {
          fdatasyncSync(fd);
        }
        return {
          payload,
          offset,
          length: encoded.length,
        };
      } finally {
        closeSync(fd);
      }
    });
  }

  public recoverAndRead(): WalRecord[] {
    return this.withLock(() => {
      this.ensureActiveWal();
      const data = readFileSync(this.walPath);
      const parsed = parseRecords(data);
      if (parsed.validBytes < data.length) {
        truncateSync(this.walPath, parsed.validBytes);
      }
      return parsed.records;
    });
  }

  private ensureActiveWal(): void {
    if (existsSync(this.walPath)) return;
    const fd = openSync(this.walPath, 'a', 0o600);
    closeSync(fd);
  }

  private rotateIfNeeded(nextRecordBytes: number): void {
    const currentSize = existsSync(this.walPath) ? statSync(this.walPath).size : 0;
    if (currentSize + nextRecordBytes <= this.maxWalBytes) {
      return;
    }

    const tmpPath = `${this.walPath}.tmp`;
    const tmpFd = openSync(tmpPath, 'w', 0o600);
    try {
      fdatasyncSync(tmpFd);
    } finally {
      closeSync(tmpFd);
    }

    if (this.faultInject === 'wal-rename-pre-sync') {
      throw new Error('fault-inject: wal-rename-pre-sync');
    }

    const archivePath = `${this.walPath}.${Date.now()}.log`;
    if (existsSync(this.walPath)) {
      renameSync(this.walPath, archivePath);
    }
    renameSync(tmpPath, this.walPath);
    this.fsyncParentDir();
  }

  private fsyncParentDir(): void {
    const dirFd = openSync(dirname(this.walPath), 'r');
    try {
      fsyncSync(dirFd);
    } finally {
      closeSync(dirFd);
    }
  }

  private withLock<T>(fn: () => T): T {
    const started = Date.now();
    while (true) {
      let lockFd = -1;
      try {
        lockFd = openSync(this.lockPath, 'wx', 0o600);
        try {
          return fn();
        } finally {
          closeSync(lockFd);
          unlinkSync(this.lockPath);
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') {
          throw error;
        }
        if (Date.now() - started > this.lockTimeoutMs) {
          throw new Error(`lock timeout for ${this.lockPath}`);
        }
        sleepMs(10);
      }
    }
  }
}
