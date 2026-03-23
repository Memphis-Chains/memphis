import { getRecentBlocks } from '../../infra/storage/rust-chain-adapter.js';
import type { Block } from '../../memory/chain.js';

export interface ChainQueryInput {
  chain?: string;
  limit?: number;
  offset?: number;
  blockType?: string;
  contains?: string;
  tag?: string;
}

export interface ChainQueryOutput {
  chain: string;
  count: number;
  blocks: Block[];
}

/**
 * Query chain blocks with optional filtering by type, content, tag.
 * Uses the TS filesystem fallback (no Rust bridge required).
 */
export async function runMemphisChainQuery(input: ChainQueryInput): Promise<ChainQueryOutput> {
  const chain = input.chain ?? 'journal';
  const limit = input.limit ?? 20;
  const offset = input.offset ?? 0;

  // Fetch enough blocks to cover offset + limit
  let blocks = await getRecentBlocks(chain, limit + offset);

  // Apply offset
  if (offset > 0) {
    blocks = blocks.slice(offset);
  }

  if (input.blockType) {
    const targetType = input.blockType;
    blocks = blocks.filter((b) => {
      const data = b.data as Record<string, unknown> | undefined;
      return data?.type === targetType;
    });
  }

  if (input.contains) {
    const needle = input.contains.toLowerCase();
    blocks = blocks.filter((b) => {
      const content = typeof b.data === 'string' ? b.data : JSON.stringify(b.data);
      return content.toLowerCase().includes(needle);
    });
  }

  if (input.tag) {
    const targetTag = input.tag;
    blocks = blocks.filter((b) => {
      const data = b.data as Record<string, unknown> | undefined;
      const tags = Array.isArray(data?.tags) ? data.tags : [];
      return tags.includes(targetTag);
    });
  }

  // Apply limit after filtering
  blocks = blocks.slice(0, limit);

  return {
    chain,
    count: blocks.length,
    blocks,
  };
}
