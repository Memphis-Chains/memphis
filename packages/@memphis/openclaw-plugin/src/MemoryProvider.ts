import { MemphisClient } from './MemphisClient.js';
import type {
  MemoryEntry,
  MemorySearchManager,
  MemphisPluginConfig,
  SearchOptions,
  SearchResult,
} from './types.js';

export class MemphisMemoryProvider implements MemorySearchManager {
  private readonly client: MemphisClient;
  private readonly defaultLimit: number;

  constructor(config: MemphisPluginConfig = {}) {
    this.client = new MemphisClient({
      baseUrl: config.baseUrl,
      timeoutMs: config.timeoutMs,
      apiKey: config.apiKey,
      userId: config.userId,
      auditLogPath: config.auditLogPath,
    });
    this.defaultLimit = config.defaultLimit ?? 10;
  }

  async search(query: string, options?: SearchOptions): Promise<SearchResult[]> {
    const limit = options?.limit ?? this.defaultLimit;
    const results = await this.client.search(query, limit);

    return results.map((r) => ({
      id: r.hash,
      content: r.content,
      score: typeof r.score === 'number' ? r.score : 0,
      metadata: {
        tags: r.tags ?? [],
        chain: r.chain ?? 'journal',
        index: r.index,
      },
    }));
  }

  async save(content: string, metadata?: Record<string, unknown>): Promise<string> {
    const tags = Array.isArray(metadata?.tags)
      ? metadata.tags.filter((v): v is string => typeof v === 'string')
      : undefined;

    const result = await this.client.save(content, tags);
    if (!result.success || !result.id) {
      throw new Error('Memphis save failed');
    }

    return result.id;
  }

  async get(id: string): Promise<MemoryEntry | null> {
    const results = await this.client.search(id, 20);
    const exact = results.find((r) => r.hash === id || String(r.index ?? '') === id);
    if (!exact) return null;

    return {
      id: exact.hash,
      content: exact.content,
      metadata: {
        tags: exact.tags ?? [],
        chain: exact.chain ?? 'journal',
        index: exact.index,
      },
    };
  }

  async delete(id: string): Promise<boolean> {
    // Memphis chains are append-only. We record a tombstone decision for auditability.
    const result = await this.client.decide('memory-delete', `Tombstone for memory ${id}`, [
      'memory',
      'delete',
    ]);
    return result.success;
  }
}
