import { stableStringify } from '../core/stable-stringify.js';
import type { Block } from '../memory/chain.js';

export type DiffConflict = {
  key: string;
  local: Block;
  remote: Block;
};

export type ChainDiffResult = {
  localOnly: Block[];
  remoteOnly: Block[];
  conflicts: DiffConflict[];
};

export function blockKey(block: Block): string {
  if (block.hash) return `hash:${block.hash}`;
  if (typeof block.index === 'number') return `idx:${block.index}`;
  return `ts:${block.timestamp ?? 'unknown'}:${stableStringify(block.data ?? {})}`;
}

export function blockFingerprint(block: Block): string {
  return stableStringify({
    index: block.index,
    timestamp: block.timestamp,
    hash: block.hash,
    chain: block.chain,
    data: block.data ?? {},
  });
}

export function detectChainDiff(local: Block[], remote: Block[]): ChainDiffResult {
  const localMap = new Map(local.map((b) => [blockKey(b), b]));
  const remoteMap = new Map(remote.map((b) => [blockKey(b), b]));

  const localOnly: Block[] = [];
  const remoteOnly: Block[] = [];
  const conflicts: DiffConflict[] = [];

  for (const [key, localBlock] of localMap.entries()) {
    const remoteBlock = remoteMap.get(key);
    if (!remoteBlock) {
      localOnly.push(localBlock);
      continue;
    }
    if (blockFingerprint(localBlock) !== blockFingerprint(remoteBlock)) {
      conflicts.push({ key, local: localBlock, remote: remoteBlock });
    }
  }

  for (const [key, remoteBlock] of remoteMap.entries()) {
    if (!localMap.has(key)) {
      remoteOnly.push(remoteBlock);
    }
  }

  return { localOnly, remoteOnly, conflicts };
}
