import { indexExactSearchBlock } from './exact-search.js';
import { appendBlock } from '../storage/chain-adapter.js';
import { embedStore } from '../storage/rust-embed-adapter.js';

export type DurableMemoryStoreInput = {
  content: string;
  tags?: string[];
  memoryId?: string;
  source?: string;
  chain?: string;
};

export type DurableMemoryStoreResult = {
  success: boolean;
  memoryId: string;
  index: number;
  hash: string;
  indexed: boolean;
  embed?: { id: string; count: number; dim: number; provider: string };
};

export type DurableMemoryDeps = {
  append: typeof appendBlock;
  index: typeof embedStore;
  indexExact?: typeof indexExactSearchBlock;
};

const defaultDeps: DurableMemoryDeps = {
  append: appendBlock,
  index: embedStore,
  indexExact: indexExactSearchBlock,
};

export async function storeDurableMemory(
  input: DurableMemoryStoreInput,
  deps: DurableMemoryDeps = defaultDeps,
): Promise<DurableMemoryStoreResult> {
  const chain = input.chain?.trim() || 'journal';
  const block = await deps.append(chain, {
    content: input.content,
    tags: input.tags ?? [],
    source: input.source ?? 'memphis',
    memory_id: input.memoryId,
  });

  const memoryId = input.memoryId?.trim() || `journal-${String(block.index)}`;

  try {
    deps.indexExact?.(
      {
        chain,
        index: block.index,
        hash: block.hash,
        data: {
          content: input.content,
          tags: input.tags ?? [],
          source: input.source ?? 'memphis',
          memory_id: memoryId,
        },
      },
      process.env,
    );
  } catch {
    // Exact search is derived state and can be rebuilt from durable blocks.
  }

  try {
    const embed = deps.index(memoryId, input.content, undefined, input.tags);
    return {
      success: true,
      memoryId,
      index: block.index,
      hash: block.hash,
      indexed: true,
      embed,
    };
  } catch {
    return {
      success: true,
      memoryId,
      index: block.index,
      hash: block.hash,
      indexed: false,
    };
  }
}
