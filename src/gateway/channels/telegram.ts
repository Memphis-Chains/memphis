import { Bot, InputFile } from 'grammy';

import { parseTelegramAllowedUserIds } from './telegram-readiness.js';
import { splitText } from './utils.js';
import { getCognitiveModeConfig, isValidCognitiveMode } from '../../cognitive/modes.js';
import { validateOperatorPassphrase } from '../../infra/auth/operator-gate.js';
import { getCognitiveMode, setCognitiveMode } from '../../soul/manifest.js';
import type { ChannelAdapter, MessageHandler } from '../chat-types.js';
import {
  resolveVoiceConfig,
  speechToText,
  textToSpeech,
  type VoiceConfig,
} from '../voice/voice-service.js';

export type TelegramAdapterOptions = {
  onStatus?: () => string;
  onRecall?: (userId: string) => Promise<string>;
  /** Returns chain block counts using the Rust NAPI chain integrity check. */
  onChains?: () => Promise<string>;
  /** Semantic search via Rust NAPI HNSW embed_search. */
  onSearch?: (query: string) => Promise<string>;
  /**
   * Called once per chatId on the first message of a bot session.
   * Returns a startup context string injected into the system prompt for that turn.
   * sessionTier reflects the current elevation for this chat (default 0).
   */
  onStartupContext?: (userId: string, sessionTier: 0 | 1 | 2) => Promise<string>;
};

// ─── Per-session tier state ──────────────────────────────────────────────────

type TierSession = {
  tier: 0 | 1 | 2;
  expiresAt: number;
};

/** chatId → active tier elevation (expires after TTL or bot restart). */
const sessionTierMap = new Map<string, TierSession>();

const TIER_TTL_MS = 15 * 60 * 1000; // 15 minutes

function getSessionTier(chatId: string): 0 | 1 | 2 {
  const session = sessionTierMap.get(chatId);
  if (!session) return 0;
  if (Date.now() > session.expiresAt) {
    sessionTierMap.delete(chatId);
    return 0;
  }
  return session.tier;
}

function setSessionTier(chatId: string, tier: 0 | 1 | 2): void {
  if (tier === 0) {
    sessionTierMap.delete(chatId);
    return;
  }
  sessionTierMap.set(chatId, { tier, expiresAt: Date.now() + TIER_TTL_MS });
}

// ─── Env override for surface policy ────────────────────────────────────────

function buildTierEnvOverride(tier: 0 | 1 | 2): Record<string, string> | undefined {
  // Surface policy env key: MEMPHIS_SURFACE_TELEGRAM_MAX_TOOL_TIER
  // Only override when tier > 0 (default is 0 for chat surface)
  if (tier === 0) return undefined;
  return { MEMPHIS_SURFACE_TELEGRAM_MAX_TOOL_TIER: String(tier) };
}

// ─── /tier command handler ────────────────────────────────────────────────────

async function handleTierCommand(
  ctx: { message: { chat: { id: number }; text?: string }; reply: (text: string) => Promise<unknown> },
): Promise<void> {
  const chatId = String(ctx.message.chat.id);
  const text = ctx.message.text ?? '';
  // /tier            → show current tier
  // /tier 0          → downgrade to safe
  // /tier 1          → upgrade to tier 1 (network/read)
  // /tier 2 <pass>   → upgrade to tier 2 with passphrase
  const parts = text.split(/\s+/);
  const requestedTier = parts[1];

  if (!requestedTier) {
    const current = getSessionTier(chatId);
    const expiresAt = sessionTierMap.get(chatId)?.expiresAt;
    const expiresIn = expiresAt ? Math.max(0, Math.round((expiresAt - Date.now()) / 1000 / 60)) : 0;
    const msg =
      current === 0
        ? 'Tier: 0 (safe — memory tools only)'
        : `Tier: ${current} — expires in ~${expiresIn}min\nUse /tier 0 to downgrade.`;
    await ctx.reply(msg);
    return;
  }

  const tier = Number(requestedTier);
  if (![0, 1, 2].includes(tier)) {
    await ctx.reply('Usage: /tier [0|1|2] [passphrase for tier 2]');
    return;
  }

  if (tier === 0) {
    setSessionTier(chatId, 0);
    await ctx.reply('Tier downgraded to 0 (safe mode).');
    return;
  }

  if (tier === 1) {
    setSessionTier(chatId, 1);
    await ctx.reply('Tier set to 1 (network/read). Expires in 15min.');
    return;
  }

  // Tier 2: require passphrase
  const passphrase = parts.slice(2).join(' ').trim();
  if (!passphrase) {
    await ctx.reply('Tier 2 requires a passphrase: /tier 2 <passphrase>');
    return;
  }

  try {
    const valid = validateOperatorPassphrase(passphrase);
    if (!valid) {
      await ctx.reply('Incorrect passphrase. Tier unchanged.');
      return;
    }
    setSessionTier(chatId, 2);
    await ctx.reply('Tier 2 unlocked (execute). Expires in 15min.\nUse /tier 0 to lock down.');
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await ctx.reply(`Passphrase check failed: ${msg}`);
  }
}

// ─── Adapter ─────────────────────────────────────────────────────────────────

export function createTelegramAdapter(
  token: string,
  options: TelegramAdapterOptions = {},
): ChannelAdapter {
  const bot = new Bot(token);
  let started = false;
  /** chatIds that have already received startup context this session. */
  const seenChatIds = new Set<string>();
  /** chatIds with pending voice reply — send TTS after text reply. */
  const pendingVoiceReply = new Set<string>();
  /** Cached voice config (resolved once at adapter creation). */
  const voiceConf: VoiceConfig | null = resolveVoiceConfig(process.env);

  return {
    name: 'telegram',

    async start(handler: MessageHandler): Promise<void> {
      bot.command(['start', 'help'], async (ctx) => {
        await ctx.reply(
          "Memphis agent online. Send a message to chat.\n\nCommands:\n/status — runtime status and version\n/chains — chain integrity and block counts (Rust core)\n/search <query> — semantic memory search (Rust HNSW)\n/recall — what I remember about you\n/tier — tool tier (0=safe, 1=network, 2=execute)\n/mode [A|B|C|D|E] — cognitive mode (A=capture, B=inferred, C=predictive, D=collective, E=meta)\n/evolve <intent> — self-modify codebase (tier 2 required, test-gated)",
        );
      });

      bot.command('status', async (ctx) => {
        const text = options.onStatus?.() ?? 'Soul is online.';
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
        await handleTierCommand({
          message: { chat: ctx.message.chat, text: ctx.message.text },
          reply: (text) => ctx.reply(text),
        });
      });

      bot.command('mode', async (ctx) => {
        const text = ctx.message?.text ?? '';
        const arg = text.replace(/^\/mode\s*/, '').trim().toUpperCase();
        if (!arg) {
          const current = getCognitiveMode();
          const config = getCognitiveModeConfig(current);
          await ctx.reply(`Mode: ${current} — ${config.name}\n${config.description}`);
          return;
        }
        if (!isValidCognitiveMode(arg)) {
          await ctx.reply('Usage: /mode [A|B|C|D|E]');
          return;
        }
        const prev = getCognitiveMode();
        setCognitiveMode(arg as 'A' | 'B' | 'C' | 'D' | 'E');
        const config = getCognitiveModeConfig(arg as 'A' | 'B' | 'C' | 'D' | 'E');
        await ctx.reply(`Mode: ${prev} → ${arg} (${config.name})\n${config.description}`);
      });

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
        const tier = getSessionTier(chatId);

        if (tier < 2) {
          await ctx.reply('Self-modification requires tier 2.\nUse: /tier 2 <passphrase>');
          return;
        }

        const intent = (msg.text ?? '').replace(/^\/evolve\s*/, '').trim();
        if (!intent) {
          await ctx.reply('Usage: /evolve <intent>\nExample: /evolve add health check endpoint to HTTP server');
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
            rawEnvOverride: buildTierEnvOverride(tier),
            systemPromptAppend: evolvePrompt,
          });
        } catch (err) {
          const errMsg = err instanceof Error ? err.message : String(err);
          await ctx.reply(`Evolution failed: ${errMsg.slice(0, 300)}`);
        } finally {
          clearInterval(typingInterval);
        }
      });

      bot.on('message:text', async (ctx) => {
        const msg = ctx.message;
        if (!msg.text || msg.from?.is_bot) return;
        if (msg.text.startsWith('/')) return;

        // User allowlist check
        const allowedIds = parseTelegramAllowedUserIds(process.env);
        const fromId = msg.from?.id;
        if (allowedIds.length > 0 && (fromId === undefined || !allowedIds.includes(String(fromId)))) {
          await ctx.reply('Access denied.');
          return;
        }

        await ctx.replyWithChatAction('typing');
        const typingInterval = setInterval(() => {
          void ctx.replyWithChatAction('typing');
        }, 4000);

        const chatId = String(msg.chat.id);
        const userId = `telegram:${String(msg.from?.id ?? 'unknown')}`;
        const sessionTier = getSessionTier(chatId);
        const rawEnvOverride = buildTierEnvOverride(sessionTier);

        // Startup context: injected once per chatId per bot session
        let systemPromptAppend: string | undefined;
        if (!seenChatIds.has(chatId) && options.onStartupContext) {
          seenChatIds.add(chatId);
          try {
            systemPromptAppend = await options.onStartupContext(userId, sessionTier);
          } catch {
            // non-fatal — continue without startup context
          }
        } else {
          seenChatIds.add(chatId);
        }

        try {
          await handler({
            id: String(msg.message_id),
            channel: 'telegram',
            userId,
            chatId,
            text: msg.text,
            timestamp: new Date(msg.date * 1000),
            rawEnvOverride,
            systemPromptAppend,
          });
        } catch (err) {
          const errMsg = err instanceof Error ? err.message : String(err);
          if (errMsg.includes('limit') || errMsg.includes('halt')) {
            await ctx.reply(
              'Przekroczyłem limit narzędzi w tej odpowiedzi. Zapytaj mnie ponownie.',
            );
          } else {
            await ctx.reply(`Wystąpił błąd: ${errMsg.slice(0, 200)}`);
          }
        } finally {
          clearInterval(typingInterval);
        }
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
            await ctx.reply(`STT error: ${sttResult.error ?? 'empty transcription'}`);
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
          const sessionTier = getSessionTier(chatId);

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
              rawEnvOverride: buildTierEnvOverride(sessionTier),
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

      void bot.start({ drop_pending_updates: true });
      started = true;
    },

    async send(chatId: string, text: string): Promise<void> {
      const trimmed = text?.trim();
      if (!trimmed) {
        await bot.api.sendMessage(chatId, '(brak odpowiedzi — spróbuj ponownie)');
        return;
      }
      // Always send text reply
      const chunks = splitText(trimmed, 4096);
      for (const chunk of chunks) {
        await bot.api.sendMessage(chatId, chunk);
      }
      // If this was a voice message, also send TTS audio reply
      if (pendingVoiceReply.has(chatId) && voiceConf) {
        try {
          // Truncate to ~500 chars for TTS (voice messages should be concise)
          const ttsText = trimmed.length > 500 ? trimmed.slice(0, 497) + '...' : trimmed;
          const ttsResult = await textToSpeech(ttsText, voiceConf);
          if (!ttsResult.error && ttsResult.audio.length > 0) {
            await bot.api.sendVoice(chatId, new InputFile(ttsResult.audio, 'reply.ogg'));
          }
        } catch {
          // TTS is best-effort — text reply was already sent
        }
      }
    },

    async stop(): Promise<void> {
      if (started) await bot.stop();
    },
  };
}
