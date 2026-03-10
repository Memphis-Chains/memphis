import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { extname, resolve } from 'node:path';

export type ChainIndexEntry = {
  chain: string;
  index: number;
  hash: string;
  prev_hash: string;
};

export type ChainIndexRebuildResult = {
  ok: boolean;
  indexPath: string;
  sourcesScanned: number;
  sourcesImported: number;
  corruptedSources: string[];
  missingIndexRecovered: boolean;
  entries: number;
};

type ChainJsonShape = { blocks?: unknown[]; chain?: unknown[] };

function parseBlocks(raw: string): unknown[] {
  const parsed = JSON.parse(raw) as ChainJsonShape | unknown[];
  if (Array.isArray(parsed)) return parsed;
  if (parsed && typeof parsed === 'object') {
    if (Array.isArray(parsed.blocks)) return parsed.blocks;
    if (Array.isArray(parsed.chain)) return parsed.chain;
  }
  return [];
}

function asEntry(value: unknown): ChainIndexEntry | null {
  if (!value || typeof value !== 'object') return null;
  const obj = value as Record<string, unknown>;
  const hash = typeof obj.hash === 'string' ? obj.hash : undefined;
  if (!hash) return null;

  const indexRaw = obj.index;
  const index =
    typeof indexRaw === 'number' && Number.isFinite(indexRaw)
      ? Math.trunc(indexRaw)
      : typeof indexRaw === 'string' && /^\d+$/.test(indexRaw)
        ? Number(indexRaw)
        : 0;

  const prev_hash = typeof obj.prev_hash === 'string' ? obj.prev_hash : '0'.repeat(64);
  const chain = typeof obj.chain === 'string' && obj.chain.length > 0 ? obj.chain : 'default';

  return { chain, index, hash, prev_hash };
}

export function rebuildChainIndexes(options?: {
  dataDir?: string;
  indexFile?: string;
}): ChainIndexRebuildResult {
  const dataDir = resolve(options?.dataDir ?? './data');
  const indexPath = resolve(options?.indexFile ?? `${dataDir}/chain-indexes.json`);

  mkdirSync(dataDir, { recursive: true });

  const files = existsSync(dataDir)
    ? readdirSync(dataDir)
        .filter((name) => extname(name) === '.json' && name !== 'chain-indexes.json')
        .map((name) => resolve(dataDir, name))
    : [];

  const entries: ChainIndexEntry[] = [];
  const corruptedSources: string[] = [];

  for (const file of files) {
    try {
      const blocks = parseBlocks(readFileSync(file, 'utf8'));
      for (const block of blocks) {
        const entry = asEntry(block);
        if (entry) entries.push(entry);
      }
    } catch {
      corruptedSources.push(file);
    }
  }

  entries.sort((a, b) => {
    if (a.chain === b.chain) return a.index - b.index;
    return a.chain.localeCompare(b.chain);
  });

  const missingIndexRecovered = !existsSync(indexPath);
  writeFileSync(
    indexPath,
    `${JSON.stringify({
      generatedAt: new Date().toISOString(),
      entries,
      corruptedSources,
    }, null, 2)}\n`,
    'utf8',
  );

  return {
    ok: true,
    indexPath,
    sourcesScanned: files.length,
    sourcesImported: files.length - corruptedSources.length,
    corruptedSources,
    missingIndexRecovered,
    entries: entries.length,
  };
}
