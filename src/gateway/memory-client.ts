/**
 * In-process memory client — calls Memphis journal/recall directly.
 */

import type { MemoryClient, RecalledContext } from './chat-types.js';
import { runMemphisJournal } from '../mcp/tools/journal.js';
import { runMemphisRecall } from '../mcp/tools/recall.js';

function shouldUseIsolatedTestMemory(rawEnv: NodeJS.ProcessEnv): boolean {
  return (
    rawEnv.NODE_ENV === 'test' &&
    !rawEnv.MEMPHIS_DATA_DIR?.trim() &&
    !rawEnv.MEMPHIS_DIR?.trim()
  );
}

export function createInProcessMemoryClient(rawEnv: NodeJS.ProcessEnv = process.env): MemoryClient {
  const isolatedTestMemory = shouldUseIsolatedTestMemory(rawEnv);

  return {
    async recall(userId: string, query: string, limit = 5): Promise<RecalledContext> {
      if (isolatedTestMemory) {
        return {
          mode: 'none',
          degraded: false,
          items: [],
        };
      }

      const result = runMemphisRecall(
        { query, limit: Math.min(limit * 3, 100) },
        { rawEnv },
      );
      const userTag = `[${userId}]`;
      const filtered = result.results.filter((r) => r.content.includes(userTag)).slice(0, limit);
      return {
        mode: result.mode,
        degraded: result.degraded,
        warning: result.warning,
        items: filtered.map((r) => ({ content: r.content, score: r.score })),
      };
    },

    async store(userId: string, userText: string, assistantReply: string): Promise<void> {
      if (isolatedTestMemory) {
        return;
      }

      const content = `[${userId}] User: ${userText}\nAssistant: ${assistantReply.slice(0, 500)}`;
      const result = await runMemphisJournal({ content, tags: ['conversation', userId] });
      if (!result.success) {
        throw new Error(result.error ?? 'memory_store_blocked');
      }
    },

    isAvailable(): boolean {
      return true;
    },
  };
}
