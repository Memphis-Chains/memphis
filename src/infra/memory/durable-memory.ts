import { indexExactSearchBlock } from './exact-search.js';
import { scanContent } from '../../security/content-scan.js';
import { emitRuntimeSecurityEvent } from '../../security/runtime-security-events.js';
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

function uniqueTags(tags: string[]): string[] {
  return Array.from(new Set(tags.filter((tag) => tag.trim().length > 0)));
}

export function buildDefaultMemoryId(chain: string, index: number): string {
  return `${chain}-${String(index)}`;
}

export function buildEmbedTags(chain: string, tags?: string[]): string[] {
  return uniqueTags([...(tags ?? []), `chain:${chain}`]);
}

export async function storeDurableMemory(
  input: DurableMemoryStoreInput,
  deps: DurableMemoryDeps = defaultDeps,
): Promise<DurableMemoryStoreResult> {
  const scan = scanContent(input.content, 'memory');
  if (!scan.allowed) {
    await emitRuntimeSecurityEvent({
      action: 'content_scan.durable_memory.blocked',
      status: 'blocked',
      details: {
        patternId: scan.patternId,
        reason: scan.reason,
        profile: scan.profile,
        contentHash: scan.contentHash,
        source: input.source ?? 'memphis',
        chain: input.chain?.trim() || 'journal',
      },
    });
    throw new Error(`Blocked durable memory content: ${scan.reason}`);
  }

  const chain = input.chain?.trim() || 'journal';
  const block = await deps.append(chain, {
    content: input.content,
    tags: input.tags ?? [],
    source: input.source ?? 'memphis',
    memory_id: input.memoryId,
  });

  const memoryId = input.memoryId?.trim() || buildDefaultMemoryId(chain, block.index);
  const embedTags = buildEmbedTags(chain, input.tags);

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
    const embed = deps.index(memoryId, input.content, undefined, embedTags);
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
