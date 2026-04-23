/**
 * In-process memory client — calls Memphis journal/recall directly.
 */

import type { MemoryClient, MemoryStoreBinding, RecalledContext } from './chat-types.js';
import { runMemphisJournal } from '../mcp/tools/journal.js';
import { runMemphisRecall } from '../mcp/tools/recall.js';

function shouldUseIsolatedTestMemory(rawEnv: NodeJS.ProcessEnv): boolean {
  return (
    rawEnv.NODE_ENV === 'test' && !rawEnv.MEMPHIS_DATA_DIR?.trim() && !rawEnv.MEMPHIS_DIR?.trim()
  );
}

export type InProcessMemoryClientOptions = {
  rawEnv?: NodeJS.ProcessEnv;
  /**
   * Caller surface used for per-surface consent resolution on journal
   * writes. Maps to `resolveSurfacePolicy(surface).defaultConsent` via
   * `runMemphisJournal` → `resolveConsent`. Defaults to 'cli.chat' since
   * the original caller was the CLI interactive chat path, but every
   * non-CLI call site (HTTP server, telegram bootstrap, worker handler)
   * MUST pass its own surface so env overrides like
   * `MEMPHIS_SURFACE_TELEGRAM_DEFAULT_CONSENT` actually take effect.
   */
  surface?: string;
};

export function createInProcessMemoryClient(
  options: NodeJS.ProcessEnv | InProcessMemoryClientOptions = process.env,
): MemoryClient {
  // Back-compat: the legacy single-arg form passed `rawEnv` positionally.
  const resolved: InProcessMemoryClientOptions =
    options && typeof options === 'object' && 'surface' in options
      ? options
      : { rawEnv: options as NodeJS.ProcessEnv };
  const rawEnv = resolved.rawEnv ?? process.env;
  const surface = resolved.surface ?? 'cli.chat';
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

      const result = runMemphisRecall({ query, limit: Math.min(limit * 3, 100) }, { rawEnv });
      const userTag = `[${userId}]`;
      const filtered = result.results.filter((r) => r.content.includes(userTag)).slice(0, limit);
      return {
        mode: result.mode,
        degraded: result.degraded,
        warning: result.warning,
        items: filtered.map((r) => ({ content: r.content, score: r.score })),
      };
    },

    async store(
      userId: string,
      userText: string,
      assistantReply: string,
      binding?: MemoryStoreBinding,
    ): Promise<void> {
      if (isolatedTestMemory) {
        return;
      }

      const content = `[${userId}] User: ${userText}\nAssistant: ${assistantReply.slice(0, 500)}`;
      const result = await runMemphisJournal({
        content,
        tags: ['conversation', userId],
        surface,
        conversationId: binding?.conversationId,
        sessionId: binding?.sessionId,
      });
      if (!result.success) {
        throw new Error(result.error ?? 'memory_store_blocked');
      }
    },

    isAvailable(): boolean {
      return true;
    },
  };
}
