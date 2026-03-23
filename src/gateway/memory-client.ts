/**
 * In-process memory client — calls Memphis journal/recall directly.
 */

import type { MemoryClient, RecalledContext } from './chat-types.js';
import { runMemphisJournal } from '../mcp/tools/journal.js';
import { runMemphisRecall } from '../mcp/tools/recall.js';

export function createInProcessMemoryClient(): MemoryClient {
  return {
    async recall(userId: string, query: string, limit = 5): Promise<RecalledContext> {
      const result = runMemphisRecall({ query, limit: Math.min(limit * 3, 100) });
      const userTag = `[${userId}]`;
      const filtered = result.results.filter((r) => r.content.includes(userTag)).slice(0, limit);
      return {
        items:
          filtered.length > 0
            ? filtered.map((r) => ({ content: r.content, score: r.score }))
            : result.results.slice(0, limit).map((r) => ({ content: r.content, score: r.score })),
      };
    },

    async store(userId: string, userText: string, assistantReply: string): Promise<void> {
      const content = `[${userId}] User: ${userText}\nAssistant: ${assistantReply.slice(0, 500)}`;
      await runMemphisJournal({ content, tags: ['conversation', userId] });
    },

    isAvailable(): boolean {
      return true;
    },
  };
}
