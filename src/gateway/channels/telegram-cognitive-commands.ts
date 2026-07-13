import type { Bot } from 'grammy';

import { getCognitiveModeConfig, isValidCognitiveMode } from '../../cognitive/modes.js';
import { getCognitiveMode, setCognitiveMode } from '../../soul/manifest.js';

export function registerTelegramCognitiveCommands(bot: Bot): void {
  bot.command('mode', async (ctx) => {
    const text = ctx.message?.text ?? '';
    const arg = text
      .replace(/^\/mode\s*/, '')
      .trim()
      .toUpperCase();
    if (!arg) {
      const current = getCognitiveMode(process.env);
      const config = getCognitiveModeConfig(current);
      await ctx.reply(`Mode: ${current} — ${config.name}\n${config.description}`);
      return;
    }
    if (!isValidCognitiveMode(arg)) {
      await ctx.reply('Usage: /mode [A|B|C|D|E]');
      return;
    }
    const prev = getCognitiveMode(process.env);
    setCognitiveMode(arg as 'A' | 'B' | 'C' | 'D' | 'E');
    const config = getCognitiveModeConfig(arg as 'A' | 'B' | 'C' | 'D' | 'E');
    await ctx.reply(`Mode: ${prev} → ${arg} (${config.name})\n${config.description}`);
  });
}
