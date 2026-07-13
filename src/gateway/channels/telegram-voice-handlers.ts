import type { Bot } from 'grammy';

import { parseTelegramAllowedUserIds } from './telegram-readiness.js';
import { buildTelegramTierEnvOverride, isTelegramTier2FullAccess } from './telegram-tier-policy.js';
import { getTelegramSessionTier } from './telegram-tier-session.js';
import type { MessageHandler } from '../chat-types.js';
import { checkTtsQuota, getVoicePreference, setVoicePreference } from '../voice/voice-policy.js';
import { resolveVoiceConfig, speechToText } from '../voice/voice-service.js';

export function registerTelegramVoiceAndRestart(
  bot: Bot,
  token: string,
  handler: MessageHandler,
  pendingVoiceReply: Set<string>,
): void {
  bot.command('restart', async (ctx) => {
    const msg = ctx.message;
    if (!msg) return;
    const chatId = String(msg.chat.id);
    const tier = getTelegramSessionTier(chatId);
    const tier2FullAccess = isTelegramTier2FullAccess();
    if (tier < 3 && !tier2FullAccess) {
      await ctx.reply('Restart requires tier 3.\nUse: /tier 3 <passphrase>');
      return;
    }
    const reason = (msg.text ?? '').replace(/^\/restart\s*/, '').trim() || undefined;
    const { requestRestart } = await import('../../infra/runtime/self-restart.js');
    const outcome = await requestRestart({
      surface: 'telegram',
      actorId: chatId,
      reason,
      alreadyElevated: tier >= 3 || tier2FullAccess,
      elevatedVia: tier >= 3 ? undefined : 'tier2-full-access',
      rawEnv: {
        ...process.env,
        ...(buildTelegramTierEnvOverride(chatId, tier) ?? {}),
      },
    });
    if (!outcome.ok) {
      await ctx.reply(`Restart refused: ${outcome.message}`);
      return;
    }
    await ctx.reply(
      `Restart scheduled via ${outcome.supervisor.kind ?? 'allow-suicide'}; agent will be back within ${Math.ceil(outcome.drainTimeoutMs / 1000)}s.`,
    );
  });

  bot.command('voice', async (ctx) => {
    const msg = ctx.message;
    if (!msg) return;
    const chatId = String(msg.chat.id);
    const arg = (msg.text ?? '')
      .replace(/^\/voice\s*/, '')
      .trim()
      .toLowerCase();
    if (!arg || arg === 'status') {
      const pref = getVoicePreference(chatId);
      const quota = checkTtsQuota(chatId);
      await ctx.reply(
        [
          `Voice replies: ${pref}`,
          `TTS today: ${quota.used}/${quota.limit} (${quota.remaining} remaining)`,
          `Toggle with: /voice on  |  /voice off`,
        ].join('\n'),
      );
      return;
    }
    if (arg !== 'on' && arg !== 'off') {
      await ctx.reply('Usage: /voice [on|off|status]');
      return;
    }
    setVoicePreference(chatId, arg);
    await ctx.reply(
      arg === 'on'
        ? 'Voice replies enabled. Send a voice message to try it.'
        : 'Voice replies disabled. Voice → text input still works; replies will be text only.',
    );
  });

  // Voice messages — STT → agent → TTS response
  const voiceConfig = resolveVoiceConfig(process.env);
  if (voiceConfig) {
    bot.on('message:voice', async (ctx) => {
      const msg = ctx.message;
      if (!msg.voice || msg.from?.is_bot) return;

      // User allowlist check
      const allowedIds = parseTelegramAllowedUserIds(process.env);
      const fromId = msg.from?.id;
      if (allowedIds.length > 0 && (fromId === undefined || !allowedIds.includes(String(fromId)))) {
        await ctx.reply('Access denied.');
        return;
      }

      await ctx.replyWithChatAction('typing');

      // Download voice file from Telegram
      const file = await ctx.api.getFile(msg.voice.file_id);
      const fileUrl = `https://api.telegram.org/file/bot${token}/${file.file_path}`;
      const audioResponse = await fetch(fileUrl);
      if (!audioResponse.ok) {
        await ctx.reply('Nie mogłem pobrać wiadomości głosowej.');
        return;
      }
      const audioBuffer = Buffer.from(await audioResponse.arrayBuffer());

      // STT: voice → text
      const sttResult = await speechToText(audioBuffer, voiceConfig);
      if (sttResult.error || !sttResult.text) {
        // classifyWhisperError already produces an operator-actionable
        // message including the server URL and remediation hint.
        // Empty transcription = silence / unintelligible audio, distinct
        // from a server failure — surface that case differently.
        const reason = sttResult.error
          ? `⚠ ${sttResult.error}`
          : '⚠ Pusta transkrypcja — nagranie zbyt ciche lub niezrozumiałe. Spróbuj jeszcze raz.';
        await ctx.reply(reason);
        return;
      }

      // Show transcription
      await ctx.reply(`[Transkrypcja] ${sttResult.text}`);
      await ctx.replyWithChatAction('typing');
      const typingInterval = setInterval(() => {
        void ctx.replyWithChatAction('typing');
      }, 4000);

      const chatId = String(msg.chat.id);
      const userId = `telegram:${String(msg.from?.id ?? 'unknown')}`;
      const sessionTier = getTelegramSessionTier(chatId);

      try {
        // Mark this chatId for voice reply
        pendingVoiceReply.add(chatId);
        // Send transcribed text through the agent
        await handler({
          id: String(msg.message_id),
          channel: 'telegram',
          userId,
          chatId,
          text: sttResult.text,
          timestamp: new Date(msg.date * 1000),
          rawEnvOverride: buildTelegramTierEnvOverride(chatId, sessionTier),
        });
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        await ctx.reply(`Błąd: ${errMsg.slice(0, 200)}`);
      } finally {
        pendingVoiceReply.delete(chatId);
        clearInterval(typingInterval);
      }
    });
  }
}
