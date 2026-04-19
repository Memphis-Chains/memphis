// TypeScript fallback search implementation

import * as fs from 'node:fs/promises';
import * as path from 'node:path';

import { getChainPath } from '../config/paths.js';
import type { SearchResult } from '../core/types.js';

interface ChainBlock {
  index: number;
  timestamp: string;
  chain: string;
  data: Record<string, unknown>;
  prev_hash: string;
  hash: string;
}

/**
 * Search across all chain blocks for matching content.
 * Falls back to empty results if no chains exist or an error occurs.
 */
export async function searchChainTS(
  query: string,
  options: { limit?: number; chain?: string } = {},
): Promise<{ results: SearchResult[]; warning: string }> {
  const { limit = 50, chain: chainFilter } = options;

  if (!query || query.trim().length === 0) {
    return { results: [], warning: '' };
  }

  const normalizedQuery = query.toLowerCase().trim();
  const queryTerms = normalizedQuery.split(/\s+/).filter((t) => t.length >= 2);

  if (queryTerms.length === 0) {
    return { results: [], warning: '' };
  }

  try {
    const chainsDir = getChainPath();
    const allBlocks: Array<{ block: ChainBlock; chain: string }> = [];

    // Get list of chain directories
    let chainNames: string[] = [];
    try {
      const entries = await fs.readdir(chainsDir, { withFileTypes: true });
      chainNames = entries.filter((e) => e.isDirectory()).map((e) => e.name);
    } catch {
      return { results: [], warning: 'Chain directory not accessible' };
    }

    // Filter to specific chain if requested
    if (chainFilter) {
      chainNames = chainNames.filter((n) => n === chainFilter);
    }

    // Load all blocks from all chains
    for (const chainName of chainNames) {
      const chainDir = path.join(chainsDir, chainName);
      try {
        const files = (await fs.readdir(chainDir)).filter((f) => f.endsWith('.json'));

        for (const file of files) {
          try {
            const content = await fs.readFile(path.join(chainDir, file), 'utf-8');
            const block = JSON.parse(content) as ChainBlock;
            if (isValidBlock(block)) {
              allBlocks.push({ block, chain: chainName });
            }
          } catch {
            // Skip malformed block files
          }
        }
      } catch {
        // Skip inaccessible chain directories
      }
    }

    // Score and rank results
    const scored = allBlocks
      .map(({ block, chain }) => {
        const score = calculateScore(block, queryTerms, normalizedQuery);
        return { block, chain, score };
      })
      .filter((item) => item.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, limit);

    const results: SearchResult[] = scored.map(({ block, chain, score }) => {
      const blockData = block.data as Record<string, unknown>;
      const content = extractSearchContent(blockData);

      return {
        id: `${chain}:${block.index}`,
        content: content.slice(0, 500),
        score,
        timestamp: block.timestamp,
        warning: chainFilter ? undefined : `matched in chain: ${chain}`,
      };
    });

    const warning = results.length === 0 ? `No matches found for: ${query}` : '';

    return { results, warning };
  } catch {
    return { results: [], warning: 'Search failed — unable to access chain data' };
  }
}

/**
 * Check if a parsed object has the required fields of a ChainBlock.
 */
function isValidBlock(block: unknown): block is ChainBlock {
  if (typeof block !== 'object' || block === null) return false;
  const b = block as Record<string, unknown>;
  return (
    typeof b.index === 'number' &&
    typeof b.timestamp === 'string' &&
    typeof b.chain === 'string' &&
    typeof b.hash === 'string' &&
    typeof b.data === 'object' &&
    b.data !== null
  );
}

/**
 * Calculate relevance score for a block given search terms.
 */
function calculateScore(block: ChainBlock, queryTerms: string[], fullQuery: string): number {
  const blockData = block.data as Record<string, unknown>;
  const searchableText = buildSearchableText(blockData, block.chain);
  const lower = searchableText.toLowerCase();

  let score = 0;

  // Exact phrase match gets highest score
  if (lower.includes(fullQuery)) {
    score += 0.5;
  }

  // Individual term matches
  for (const term of queryTerms) {
    if (lower.includes(term)) {
      score += 0.15;

      // Bonus for title-like fields
      const titleMatch = (blockData.title as string)?.toLowerCase().includes(term);
      const tagMatch = (blockData.tags as string[])?.some((t) => t.toLowerCase().includes(term));

      if (titleMatch) score += 0.1;
      if (tagMatch) score += 0.1;
    }
  }

  // Recency boost: newer blocks score slightly higher
  try {
    const blockAge = Date.now() - new Date(block.timestamp).getTime();
    const daysOld = blockAge / (1000 * 60 * 60 * 24);
    if (daysOld < 7) score += 0.1;
    else if (daysOld < 30) score += 0.05;
  } catch {
    // Ignore date parsing errors
  }

  return Math.min(score, 1.0);
}

/**
 * Build a searchable text string from block data.
 */
function buildSearchableText(data: Record<string, unknown>, chain: string): string {
  const parts: string[] = [chain];

  if (typeof data.content === 'string') {
    parts.push(data.content);
  }
  if (typeof data.title === 'string') {
    parts.push(data.title);
  }
  if (Array.isArray(data.tags)) {
    parts.push(data.tags.join(' '));
  }
  if (typeof data.type === 'string') {
    parts.push(data.type);
  }

  // Add key metadata fields
  for (const [key, value] of Object.entries(data)) {
    if (typeof value === 'string' && key !== 'content') {
      parts.push(value);
    }
  }

  return parts.join(' ');
}

/**
 * Extract the primary content string from block data for display.
 */
function extractSearchContent(data: Record<string, unknown>): string {
  if (typeof data.content === 'string') {
    return data.content;
  }
  if (typeof data.title === 'string') {
    return data.title;
  }
  if (typeof data.description === 'string') {
    return data.description;
  }

  // Fallback: stringify meaningful fields
  const relevant: string[] = [];
  for (const [, value] of Object.entries(data)) {
    if (typeof value === 'string' && value.length > 0 && value.length < 200) {
      relevant.push(value);
    }
  }

  return relevant.slice(0, 3).join(' | ');
}
