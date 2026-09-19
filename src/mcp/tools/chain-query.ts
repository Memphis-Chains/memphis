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
    // Tokenised case-insensitive AND match (decision #190, item 5).
    //
    // The previous substring check returned false negatives for any
    // query that wasn't an exact contiguous phrase in the block.
    // Example: query "embed reindex" missed the block "rebuild
    // derived embeddings" because the words weren't adjacent.
    //
    // Tokenise the query on whitespace, lowercase each token, require
    // every token to appear somewhere in the block content (order-
    // independent AND). Tokens retain Unicode characters intact so
    // operator-language blocks (Polish ą/ę/ó etc.) match correctly.
    const tokens = input.contains
      .toLowerCase()
      .split(/\s+/)
      .map((t) => t.trim())
      .filter((t) => t.length > 0);
    if (tokens.length === 0) {
      // Empty query after tokenisation — return nothing rather than
      // silently returning every block.
      blocks = [];
    } else {
      blocks = blocks.filter((b) => {
        const content = typeof b.data === 'string' ? b.data : JSON.stringify(b.data);
        const lower = content.toLowerCase();
        return tokens.every((token) => lower.includes(token));
      });
    }
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
