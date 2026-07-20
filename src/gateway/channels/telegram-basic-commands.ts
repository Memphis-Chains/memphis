import type { Bot } from 'grammy';

import {
  buildTelegramOperatorContext,
  handleTelegramTierCommand,
  isAllowedTelegramUser,
  type TelegramOperatorContext,
} from './telegram-tier-session.js';
import { renderSurfaceDesignGuideText } from '../../infra/operator-guide.js';

type BasicCommandOptions = {
  onStatus?: () => string;
  onTools?: (context: TelegramOperatorContext) => string | Promise<string>;
  onModel?: (context: TelegramOperatorContext) => string | Promise<string>;
  onRecall?: (userId: string) => Promise<string>;
};

export function registerTelegramBasicCommands(bot: Bot, options: BasicCommandOptions): void {
  bot.command(['start', 'help'], async (ctx) => {
    await ctx.reply(
      [
        'Memphis agent online. Send a message to chat.',
        '',
        'Commands:',
        '/status — runtime status, version, and cross-surface presence (TUI/Telegram/HTTP)',
        '/tools — live registered tool inventory for this runtime',
        '/model — live provider/model route for this runtime',
        '/guide — runtime design, tiers, and surface model',
        '/chains — chain integrity and block counts (Rust core)',
        '/search <query> — semantic memory search (Rust HNSW)',
        '/recall — what I remember about you',
        '/tier — companion surface tier (default 2, 1=reduced, 0=safe; tier 3 needs passphrase)',
        '/mode [A|B|C|D|E] — cognitive mode (A=capture, B=inferred, C=predictive, D=collective, E=meta)',
        '/config show|set|reload — show or change runtime config on the fly (tier 3 for secrets)',
        "/voice on|off|status — toggle TTS replies and view today's quota",
        '/evolve <intent> — self-modify codebase (tier 2 required, test-gated)',
        '',
        'See docs/operator-handbook.md for the full operator workflow.',
      ].join('\n'),
    );
  });

  bot.command(['guide', 'design'], async (ctx) => {
    await ctx.reply(renderSurfaceDesignGuideText('telegram', process.env));
  });

  bot.command('status', async (ctx) => {
    const text = options.onStatus?.() ?? 'Soul is online.';
    await ctx.reply(text);
  });

  bot.command('tools', async (ctx) => {
    const msg = ctx.message;
    if (!msg) return;
    if (!isAllowedTelegramUser(msg.from?.id)) {
      await ctx.reply('Access denied.');
      return;
    }
    const text = options.onTools
      ? await options.onTools(buildTelegramOperatorContext(msg))
      : 'Tool inventory not available.';
    await ctx.reply(text);
  });

  bot.command('model', async (ctx) => {
    const msg = ctx.message;
    if (!msg) return;
    if (!isAllowedTelegramUser(msg.from?.id)) {
      await ctx.reply('Access denied.');
      return;
    }
    const text = options.onModel
      ? await options.onModel(buildTelegramOperatorContext(msg))
      : 'Model route not available.';
    await ctx.reply(text);
  });

  bot.command('recall', async (ctx) => {
    const userId = `telegram:${String(ctx.from?.id ?? 'unknown')}`;
    if (options.onRecall) {
      await ctx.replyWithChatAction('typing');
      const text = await options.onRecall(userId);
      await ctx.reply(text);
    } else {
      await ctx.reply('Memory not available.');
    }
  });

  bot.command('tier', async (ctx) => {
    if (!ctx.message) return;
    await handleTelegramTierCommand({
      message: { chat: ctx.message.chat, text: ctx.message.text },
      reply: (text) => ctx.reply(text),
    });
  });
}
