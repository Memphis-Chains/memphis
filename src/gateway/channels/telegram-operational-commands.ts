import type { Bot } from 'grammy';

import { buildTelegramTierEnvOverride } from './telegram-tier-policy.js';
import { getTelegramSessionTier } from './telegram-tier-session.js';
import type { MessageHandler } from '../chat-types.js';

type OperationalCommandOptions = {
  onChains?: () => Promise<string>;
  onSearch?: (query: string) => Promise<string>;
};

export function registerTelegramOperationalCommands(
  bot: Bot,
  options: OperationalCommandOptions,
  handler: MessageHandler,
): void {
  // /chains — live Rust NAPI chain integrity + block counts
  bot.command('chains', async (ctx) => {
    if (options.onChains) {
      await ctx.replyWithChatAction('typing');
      const text = await options.onChains();
      await ctx.reply(text);
    } else {
      await ctx.reply('Chain inspection not available.');
    }
  });

  // /search <query> — Rust NAPI HNSW semantic search
  bot.command('search', async (ctx) => {
    const text = ctx.message?.text ?? '';
    const query = text.replace(/^\/search\s*/, '').trim();
    if (!query) {
      await ctx.reply('Usage: /search <query>');
      return;
    }
    if (options.onSearch) {
      await ctx.replyWithChatAction('typing');
      const result = await options.onSearch(query);
      await ctx.reply(result);
    } else {
      await ctx.reply('Semantic search not available.');
    }
  });

  // /evolve <intent> — self-modification via agent (requires tier 2)
  bot.command('evolve', async (ctx) => {
    const msg = ctx.message;
    if (!msg) return;
    const chatId = String(msg.chat.id);
    const tier = getTelegramSessionTier(chatId);

    if (tier < 2) {
      await ctx.reply('Self-modification requires tier 2.\nUse: /tier 2');
      return;
    }

    const intent = (msg.text ?? '').replace(/^\/evolve\s*/, '').trim();
    if (!intent) {
      await ctx.reply(
        'Usage: /evolve <intent>\nExample: /evolve add health check endpoint to HTTP server',
      );
      return;
    }

    await ctx.replyWithChatAction('typing');
    const typingInterval = setInterval(() => {
      void ctx.replyWithChatAction('typing');
    }, 4000);

    const userId = `telegram:${String(msg.from?.id ?? 'unknown')}`;
    const evolvePrompt = [
      '<evolve_directive>',
      `The operator has requested self-modification via /evolve.`,
      `Intent: ${intent}`,
      '',
      'You MUST use the memphis_self_modify tool to implement this change.',
      'Steps:',
      '1. Use memphis_grep and memphis_code_read to understand the relevant code',
      '2. Plan the minimal changes needed',
      '3. Call memphis_self_modify with: intent, files (list of files to change), changes (file path → new content)',
      '4. Report the result: committed, rolled-back, or error',
      '',
      'The self-modify tool will: create a snapshot, branch, apply changes, run tests, and merge only if tests pass.',
      'If tests fail, changes are automatically rolled back.',
      '</evolve_directive>',
    ].join('\n');

    try {
      await handler({
        id: String(msg.message_id),
        channel: 'telegram',
        userId,
        chatId,
        text: intent,
        timestamp: new Date(msg.date * 1000),
        rawEnvOverride: buildTelegramTierEnvOverride(chatId, tier),
        systemPromptAppend: evolvePrompt,
      });
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      await ctx.reply(`Evolution failed: ${errMsg.slice(0, 300)}`);
    } finally {
      clearInterval(typingInterval);
    }
  });
}
