import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';

import { getChainPath } from '../../config/paths.js';

export type SoulReplayBlock = {
  index: number;
  timestamp: string;
  chain: string;
  data: {
    block_type: string;
    content: string;
    tags: string[];
  };
  prev_hash: string;
  hash: string;
};

const ZERO_HASH = '0'.repeat(64);

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function normalizeBlock(raw: unknown, fallbackChain: string): SoulReplayBlock | null {
  if (!isObject(raw)) return null;

  const rawData = isObject(raw.data) ? raw.data : {};
  const tags = Array.isArray(rawData.tags)
    ? rawData.tags.filter((item): item is string => typeof item === 'string')
    : [];

  const blockType =
    typeof rawData.block_type === 'string'
      ? rawData.block_type
      : typeof rawData.type === 'string'
        ? rawData.type
        : 'journal';
  const content =
    typeof rawData.content === 'string' ? rawData.content : JSON.stringify(rawData ?? {});

  const fallbackHash = createHash('sha256').update(JSON.stringify(raw)).digest('hex');
  const hash = typeof raw.hash === 'string' && raw.hash.length > 0 ? raw.hash : fallbackHash;
  const prevHash =
    typeof raw.prev_hash === 'string' && raw.prev_hash.length > 0 ? raw.prev_hash : ZERO_HASH;

  return {
    index:
      typeof raw.index === 'number' && Number.isFinite(raw.index)
        ? Math.max(0, Math.trunc(raw.index))
        : 0,
    timestamp:
      typeof raw.timestamp === 'string' && raw.timestamp.length > 0
        ? raw.timestamp
        : new Date(0).toISOString(),
    chain: typeof raw.chain === 'string' && raw.chain.length > 0 ? raw.chain : fallbackChain,
    data: {
      block_type: blockType,
      content,
      tags,
    },
    prev_hash: prevHash,
    hash,
  };
}

export function normalizeReplayBlocks(rawBlocks: unknown[], chain: string): SoulReplayBlock[] {
  const parsed = rawBlocks
    .map((block) => normalizeBlock(block, chain))
    .filter((block): block is SoulReplayBlock => block !== null);

  parsed.sort((a, b) => a.index - b.index || a.timestamp.localeCompare(b.timestamp));

  const normalized: SoulReplayBlock[] = [];
  for (let idx = 0; idx < parsed.length; idx += 1) {
    const current = parsed[idx]!;
    normalized.push({
      ...current,
      index: idx,
      prev_hash: idx === 0 ? ZERO_HASH : normalized[idx - 1]!.hash,
    });
  }
  return normalized;
}

export async function loadReplayBlocksFromChain(
  chain: string,
  rawEnv: NodeJS.ProcessEnv = process.env,
): Promise<SoulReplayBlock[]> {
  const dir = getChainPath(chain, rawEnv);
  const files = (await readdir(dir).catch(() => []))
    .filter((file) => file.endsWith('.json'))
    .sort((a, b) => a.localeCompare(b));

  if (files.length === 0) {
    return [];
  }

  const rawBlocks: unknown[] = [];
  for (const file of files) {
    try {
      const raw = await readFile(`${dir}/${file}`, 'utf8');
      rawBlocks.push(JSON.parse(raw));
    } catch {
      // Ignore unreadable/corrupt files here; replay endpoint will report from available blocks.
    }
  }

  return normalizeReplayBlocks(rawBlocks, chain);
}
