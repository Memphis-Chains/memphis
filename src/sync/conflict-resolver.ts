import type { Block } from '../memory/chain.js';
import { blockKey } from './chain-diff.js';

export type ConflictResolutionStrategy = 'last-write-wins' | 'prefer-local' | 'prefer-remote';

export type ResolveConflictsInput = {
  local: Block[];
  remote: Block[];
  strategy?: ConflictResolutionStrategy;
};

function blockTimestamp(block: Block): number {
  const raw = block.timestamp ? Date.parse(block.timestamp) : Number.NaN;
  return Number.isFinite(raw) ? raw : 0;
}

export function resolveChainConflicts(input: ResolveConflictsInput): Block[] {
  const strategy = input.strategy ?? 'last-write-wins';
  const merged = new Map<string, Block>();

  for (const block of input.local) {
    merged.set(blockKey(block), block);
  }

  for (const remoteBlock of input.remote) {
    const key = blockKey(remoteBlock);
    const localBlock = merged.get(key);
    if (!localBlock) {
      merged.set(key, remoteBlock);
      continue;
    }

    if (strategy === 'prefer-local') continue;
    if (strategy === 'prefer-remote') {
      merged.set(key, remoteBlock);
      continue;
    }

    // last-write-wins
    const localTs = blockTimestamp(localBlock);
    const remoteTs = blockTimestamp(remoteBlock);
    if (remoteTs >= localTs) {
      merged.set(key, remoteBlock);
    }
  }

  return Array.from(merged.values()).sort((a, b) => {
    const ai = typeof a.index === 'number' ? a.index : Number.MAX_SAFE_INTEGER;
    const bi = typeof b.index === 'number' ? b.index : Number.MAX_SAFE_INTEGER;
    if (ai !== bi) return ai - bi;
    return blockTimestamp(a) - blockTimestamp(b);
  });
}
