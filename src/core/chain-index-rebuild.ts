import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { loadConfig } from '../config/index.js';

type ChainName = 'journal' | 'ask' | 'decision';

type ChainEntry = {
  hash?: string;
  timestamp?: string | number;
  tags?: string[];
};

type ChainIndexes = {
  hash: Record<string, number>;
  timestamp: Array<{ hash: string; timestamp: string | number }>;
  tags: Record<string, string[]>;
};

export type ChainRebuildOptions = {
  chains?: ChainName[];
  chainDir?: string;
  dryRun?: boolean;
  noBackup?: boolean;
  keepDays?: number;
  now?: Date;
};

export type ChainRebuildReport = {
  chains: ChainName[];
  entries: number;
  before: {
    indexSize: number;
    corrupted: number;
  };
  after: {
    indexSize: number;
    corrupted: number;
  };
  perChain: Record<ChainName, { entries: number; rebuilt: boolean }>;
  backupDir?: string;
  dryRun: boolean;
};

const DEFAULT_CHAINS: ChainName[] = ['journal', 'ask', 'decision'];

function resolveChainDir(options: ChainRebuildOptions): string {
  if (options.chainDir) return options.chainDir;
  if (process.env.MEMPHIS_CHAIN_DIR) return process.env.MEMPHIS_CHAIN_DIR;
  const config = loadConfig();
  return config.memory.path;
}

function chainFilePath(chainDir: string, chain: ChainName): string {
  return join(chainDir, `${chain}.jsonl`);
}

function indexPaths(chainDir: string, chain: ChainName): Record<'hash' | 'timestamp' | 'tags', string> {
  return {
    hash: join(chainDir, `${chain}.index.hash.json`),
    timestamp: join(chainDir, `${chain}.index.timestamp.json`),
    tags: join(chainDir, `${chain}.index.tags.json`),
  };
}

function parseJsonLine(line: string): ChainEntry | undefined {
  const trimmed = line.trim();
  if (!trimmed) return undefined;
  try {
    return JSON.parse(trimmed) as ChainEntry;
  } catch {
    return undefined;
  }
}

function readChainEntries(path: string): ChainEntry[] {
  if (!existsSync(path)) return [];
  const content = readFileSync(path, 'utf8');
  return content
    .split('\n')
    .map((line) => parseJsonLine(line))
    .filter((entry): entry is ChainEntry => Boolean(entry));
}

function computeIndexes(entries: ChainEntry[]): ChainIndexes {
  const hash: Record<string, number> = {};
  const timestamp: Array<{ hash: string; timestamp: string | number }> = [];
  const tags: Record<string, string[]> = {};

  entries.forEach((entry, idx) => {
    if (!entry.hash || typeof entry.hash !== 'string') return;
    hash[entry.hash] = idx;

    if (entry.timestamp !== undefined) {
      timestamp.push({ hash: entry.hash, timestamp: entry.timestamp });
    }

    if (Array.isArray(entry.tags)) {
      for (const rawTag of entry.tags) {
        if (typeof rawTag !== 'string' || rawTag.length === 0) continue;
        if (!tags[rawTag]) tags[rawTag] = [];
        tags[rawTag].push(entry.hash);
      }
    }
  });

  return { hash, timestamp, tags };
}

function fileSize(path: string): number {
  if (!existsSync(path)) return 0;
  return statSync(path).size;
}

function readIndexJson<T>(path: string): T | undefined {
  if (!existsSync(path)) return undefined;
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as T;
  } catch {
    return undefined;
  }
}

function countCorruption(actual: ChainIndexes, expected: ChainIndexes): number {
  let corrupted = 0;

  const actualHashKeys = new Set(Object.keys(actual.hash));
  const expectedHashKeys = new Set(Object.keys(expected.hash));
  for (const key of expectedHashKeys) {
    if (!(key in actual.hash) || actual.hash[key] !== expected.hash[key]) corrupted += 1;
  }
  for (const key of actualHashKeys) {
    if (!expectedHashKeys.has(key)) corrupted += 1;
  }

  const maxTs = Math.max(actual.timestamp.length, expected.timestamp.length);
  for (let i = 0; i < maxTs; i += 1) {
    const a = actual.timestamp[i];
    const e = expected.timestamp[i];
    if (!a || !e || a.hash !== e.hash || a.timestamp !== e.timestamp) corrupted += 1;
  }

  const tagKeys = new Set([...Object.keys(actual.tags), ...Object.keys(expected.tags)]);
  for (const tag of tagKeys) {
    const a = new Set(actual.tags[tag] ?? []);
    const e = new Set(expected.tags[tag] ?? []);
    for (const h of e) if (!a.has(h)) corrupted += 1;
    for (const h of a) if (!e.has(h)) corrupted += 1;
  }

  return corrupted;
}

function buildBackupDir(chainDir: string, now: Date): string {
  const stamp = now.toISOString().slice(0, 10);
  return join(chainDir, `.index-backup-${stamp}`);
}

function backupIndexes(chainDir: string, chains: ChainName[], backupDir: string): void {
  mkdirSync(backupDir, { recursive: true });
  for (const chain of chains) {
    const paths = indexPaths(chainDir, chain);
    for (const path of Object.values(paths)) {
      if (!existsSync(path)) continue;
      copyFileSync(path, join(backupDir, basename(path)));
    }
  }
}

function pruneBackups(chainDir: string, keepDays: number, now: Date): void {
  if (!existsSync(chainDir)) return;
  const cutoff = now.getTime() - keepDays * 24 * 60 * 60 * 1000;
  for (const name of readdirSync(chainDir)) {
    if (!name.startsWith('.index-backup-')) continue;
    const full = join(chainDir, name);
    const mtime = statSync(full).mtimeMs;
    if (mtime < cutoff) {
      rmSync(full, { recursive: true, force: true });
    }
  }
}

function writeIndexes(chainDir: string, chain: ChainName, indexes: ChainIndexes): void {
  const paths = indexPaths(chainDir, chain);
  writeFileSync(paths.hash, JSON.stringify(indexes.hash, null, 2));
  writeFileSync(paths.timestamp, JSON.stringify(indexes.timestamp, null, 2));
  writeFileSync(paths.tags, JSON.stringify(indexes.tags, null, 2));
}

export function rebuildChainIndexes(options: ChainRebuildOptions = {}): ChainRebuildReport {
  const chains = options.chains ?? DEFAULT_CHAINS;
  const chainDir = resolveChainDir(options);
  const dryRun = options.dryRun === true;
  const noBackup = options.noBackup === true;
  const keepDays = options.keepDays ?? 7;
  const now = options.now ?? new Date();

  mkdirSync(chainDir, { recursive: true });

  let totalEntries = 0;
  let beforeSize = 0;
  let beforeCorrupted = 0;
  const perChain: Record<ChainName, { entries: number; rebuilt: boolean }> = {
    journal: { entries: 0, rebuilt: false },
    ask: { entries: 0, rebuilt: false },
    decision: { entries: 0, rebuilt: false },
  };

  const computed = new Map<ChainName, ChainIndexes>();

  for (const chain of chains) {
    const entries = readChainEntries(chainFilePath(chainDir, chain));
    totalEntries += entries.length;
    perChain[chain].entries = entries.length;

    const expected = computeIndexes(entries);
    computed.set(chain, expected);

    const paths = indexPaths(chainDir, chain);
    beforeSize += fileSize(paths.hash) + fileSize(paths.timestamp) + fileSize(paths.tags);

    const hash = readIndexJson<Record<string, number>>(paths.hash);
    const timestamp = readIndexJson<Array<{ hash: string; timestamp: string | number }>>(paths.timestamp);
    const tags = readIndexJson<Record<string, string[]>>(paths.tags);

    if (!hash || !timestamp || !tags) {
      beforeCorrupted += Object.keys(expected.hash).length;
    } else {
      beforeCorrupted += countCorruption({ hash, timestamp, tags }, expected);
    }
  }

  let backupDir: string | undefined;

  if (!dryRun) {
    if (!noBackup) {
      backupDir = buildBackupDir(chainDir, now);
      backupIndexes(chainDir, chains, backupDir);
    }

    for (const chain of chains) {
      const indexes = computed.get(chain);
      if (!indexes) continue;
      writeIndexes(chainDir, chain, indexes);
      perChain[chain].rebuilt = true;
    }

    pruneBackups(chainDir, keepDays, now);
  }

  let afterSize = 0;
  let afterCorrupted = 0;

  for (const chain of chains) {
    const paths = indexPaths(chainDir, chain);
    const expected = computed.get(chain) ?? { hash: {}, timestamp: [], tags: {} };

    if (dryRun) {
      afterSize += beforeSize;
      afterCorrupted += beforeCorrupted;
      break;
    }

    afterSize += fileSize(paths.hash) + fileSize(paths.timestamp) + fileSize(paths.tags);

    const hash = readIndexJson<Record<string, number>>(paths.hash);
    const timestamp = readIndexJson<Array<{ hash: string; timestamp: string | number }>>(paths.timestamp);
    const tags = readIndexJson<Record<string, string[]>>(paths.tags);

    if (!hash || !timestamp || !tags) {
      afterCorrupted += Object.keys(expected.hash).length;
    } else {
      afterCorrupted += countCorruption({ hash, timestamp, tags }, expected);
    }
  }

  return {
    chains,
    entries: totalEntries,
    before: {
      indexSize: beforeSize,
      corrupted: beforeCorrupted,
    },
    after: {
      indexSize: dryRun ? beforeSize : afterSize,
      corrupted: dryRun ? beforeCorrupted : afterCorrupted,
    },
    perChain,
    backupDir,
    dryRun,
  };
}

export function formatChainIndexRebuildReport(report: ChainRebuildReport): string {
  const lines: string[] = [];
  lines.push('Chain Index Rebuild');
  lines.push('===================');
  lines.push(`Chains: ${report.chains.join(', ')}`);
  lines.push(`Entries: ${report.entries}`);
  lines.push('');
  lines.push('Before:');
  lines.push(`  index_size: ${report.before.indexSize} bytes`);
  lines.push(`  corrupted: ${report.before.corrupted} entries`);
  lines.push('');
  lines.push(report.dryRun ? 'Rebuilding... (dry-run)' : 'Rebuilding...');

  for (const chain of report.chains) {
    const mark = report.dryRun ? '•' : report.perChain[chain].rebuilt ? '✓' : '✗';
    lines.push(`  ${chain}: ${report.perChain[chain].entries} entries ${mark}`);
  }

  lines.push('');
  lines.push('After:');
  lines.push(`  index_size: ${report.after.indexSize} bytes`);
  lines.push(`  corrupted: ${report.after.corrupted} entries`);
  if (report.backupDir) {
    lines.push('');
    lines.push(`Backup saved to: ${report.backupDir}/`);
  }

  return lines.join('\n');
}
