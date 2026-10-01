/**
 * In-process memory client — calls Memphis journal/recall directly.
 */

import type { MemoryClient, MemoryStoreBinding, RecalledContext } from './chat-types.js';
import { runMemphisJournal } from '../mcp/tools/journal.js';
import { runMemphisRecall } from '../mcp/tools/recall.js';

function shouldUseIsolatedTestMemory(rawEnv: NodeJS.ProcessEnv): boolean {
  return rawEnv.NODE_ENV === 'test' && !rawEnv.MEMPHIS_DATA_DIR?.trim();
}

/**
 * Default cap on assistantReply length persisted into journal.
 *
 * Previously hardcoded to 500 (commit prior to 60a9f78), which silently
 * truncated every long analysis / multi-paragraph answer before it ever
 * reached the semantic index. Embedding the truncated string meant search
 * could not retrieve answers whose load-bearing content sat past the 500
 * character boundary. Raised to 4000 because:
 *   - 4 KB comfortably fits the typical structured response (intro +
 *     analysis + decision matrix + next-step), which previously exceeded
 *     500 chars in roughly 1 in 6 turns during operator testing.
 *   - Larger replies (>4 KB) are usually paste-of-logs / dump-of-stack —
 *     persisting them inflates the embed index without improving recall.
 *
 * Override per-deployment via MEMPHIS_MEMORY_REPLY_LIMIT (positive integer;
 * invalid values fall back to the default and are logged).
 */
const DEFAULT_ASSISTANT_REPLY_LIMIT = 4000;

function resolveAssistantReplyLimit(rawEnv: NodeJS.ProcessEnv | undefined): number {
  if (!rawEnv) return DEFAULT_ASSISTANT_REPLY_LIMIT;
  const raw = rawEnv.MEMPHIS_MEMORY_REPLY_LIMIT?.trim();
  if (!raw) return DEFAULT_ASSISTANT_REPLY_LIMIT;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0 || !Number.isInteger(parsed)) {
    console.warn(
      `[memory-client] ignoring invalid MEMPHIS_MEMORY_REPLY_LIMIT=${JSON.stringify(raw)}; falling back to default ${DEFAULT_ASSISTANT_REPLY_LIMIT}`,
    );
    return DEFAULT_ASSISTANT_REPLY_LIMIT;
  }
  return parsed;
}

/**
 * Detects the legacy single-arg invocation form: a raw env-like object
 * passed positionally instead of `{ rawEnv, surface }`. We keep this
 * shim because a handful of older tests and one boot path (`cli.chat`
 * pre-#650) still pass `{ NODE_ENV: 'production' }` directly to the
 * factory. New call sites should always use `{ rawEnv, surface }`.
 */
function looksLikeLegacyEnvArg(value: unknown): value is NodeJS.ProcessEnv {
  if (!value || typeof value !== 'object') return false;
  // An InProcessMemoryClientOptions object has at most one of `rawEnv` /
  // `surface`. A raw env always carries environment-style keys.
  if ('surface' in (value as Record<string, unknown>)) return false;
  if ('rawEnv' in (value as Record<string, unknown>)) return false;
  return true;
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
  // Back-compat: legacy single-arg form passed `rawEnv` positionally.
  const resolved: InProcessMemoryClientOptions = looksLikeLegacyEnvArg(options)
    ? { rawEnv: options as NodeJS.ProcessEnv }
    : (options as InProcessMemoryClientOptions);
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

      const assistantLimit = resolveAssistantReplyLimit(rawEnv);
      const storedAssistantReply =
        assistantReply.length > assistantLimit
          ? assistantReply.slice(0, assistantLimit)
          : assistantReply;
      const content = `[${userId}] User: ${userText}\nAssistant: ${storedAssistantReply}`;
      const result = await runMemphisJournal({
        content,
        tags: ['conversation', userId],
        surface,
        conversationId: binding?.conversationId,
        sessionId: binding?.sessionId,
        turnId: binding?.turnId,
        truncation:
          assistantReply.length > assistantLimit
            ? {
                field: 'assistantReply',
                originalLength: assistantReply.length,
                storedLength: storedAssistantReply.length,
                limit: assistantLimit,
              }
            : undefined,
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
