import { InputFile, type Bot } from 'grammy';

import { buildTelegramTtsReplyText } from './telegram-voice-text.js';
import { splitText } from './utils.js';
import { checkTtsQuota, consumeTtsQuota } from '../voice/voice-policy.js';
import { textToSpeech, type VoiceConfig } from '../voice/voice-service.js';

export async function deliverTelegramReply(
  bot: Bot,
  chatId: string,
  text: string,
  pendingVoiceReply: Set<string>,
  voiceConfig: VoiceConfig | null,
): Promise<void> {
  const trimmed = text?.trim();
  if (!trimmed) {
    await bot.api.sendMessage(chatId, '(brak odpowiedzi — spróbuj ponownie)');
    return;
  }

  for (const chunk of splitText(trimmed, 4096)) {
    await bot.api.sendMessage(chatId, chunk);
  }

  if (!pendingVoiceReply.has(chatId) || !voiceConfig) return;
  const quota = checkTtsQuota(chatId);
  if (!quota.allowed) {
    if (quota.reason === 'daily_limit_reached') {
      try {
        await bot.api.sendMessage(
          chatId,
          `(voice reply skipped — daily TTS limit ${quota.used}/${quota.limit} reached; resets at UTC midnight)`,
        );
      } catch {
        // Best-effort notice; the text reply was already delivered.
      }
    }
    return;
  }

  try {
    const ttsResult = await textToSpeech(buildTelegramTtsReplyText(trimmed), voiceConfig);
    if (ttsResult.error || ttsResult.audio.length === 0) return;
    // Synthesis incurs the cost, so charge before best-effort delivery.
    consumeTtsQuota(chatId);
    await bot.api.sendVoice(chatId, new InputFile(ttsResult.audio, 'reply.ogg'));
  } catch {
    // TTS is best-effort; the text reply was already delivered.
  }
}
