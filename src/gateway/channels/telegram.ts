import { Bot, InputFile } from 'grammy';

import { parseTelegramAllowedUserIds } from './telegram-readiness.js';
import { splitText } from './utils.js';
import { getCognitiveModeConfig, isValidCognitiveMode } from '../../cognitive/modes.js';
import { recordSurfaceActivity } from '../../core/surface-presence.js';
import { validateOperatorPassphrase } from '../../infra/auth/operator-gate.js';
import { renderSurfaceDesignGuideText } from '../../infra/operator-guide.js';
import {
  buildTier3EnvOverride,
  getActiveTier3Session,
  getTier3RemainingMs,
  requestTier3Elevation,
  revokeTier3Session,
} from '../../security/tier3-session.js';
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
   * sessionTier reflects the current surface tier for this chat (default 2).
   */
  onStartupContext?: (userId: string, sessionTier: 0 | 1 | 2 | 3) => Promise<string>;
};

// ─── Per-session tier state ──────────────────────────────────────────────────
//
// Tiers 0/1/2 live in this local map (15-min TTL, no passphrase). Tier 3
// lives in the shared tier3-session module (3-hour TTL, passphrase-gated,
// audited). This keeps passphrase validation and audit in one place while
// leaving the low-friction tier-0/1/2 flow unchanged.

type TierSession = {
  tier: 0 | 1 | 2;
  expiresAt: number;
};

/** chatId → active tier elevation (expires after TTL or bot restart). */
const sessionTierMap = new Map<string, TierSession>();

const TIER_TTL_MS = 15 * 60 * 1000; // 15 minutes (for tiers 0/1/2)
export const DEFAULT_TELEGRAM_SESSION_TIER = 2 as const;

function getSessionTier(chatId: string): 0 | 1 | 2 | 3 {
  if (getActiveTier3Session('telegram', chatId)) return 3;
  const session = sessionTierMap.get(chatId);
  if (!session) return DEFAULT_TELEGRAM_SESSION_TIER;
  if (Date.now() > session.expiresAt) {
    sessionTierMap.delete(chatId);
    return DEFAULT_TELEGRAM_SESSION_TIER;
  }
  return session.tier;
}

function setSessionTier(chatId: string, tier: 0 | 1 | 2): void {
  if (tier === DEFAULT_TELEGRAM_SESSION_TIER) {
    sessionTierMap.delete(chatId);
    return;
  }
  sessionTierMap.set(chatId, { tier, expiresAt: Date.now() + TIER_TTL_MS });
}

// ─── Env override for surface policy ────────────────────────────────────────

function buildTierEnvOverride(
  chatId: string,
  tier: 0 | 1 | 2 | 3,
): Record<string, string> | undefined {
  if (tier === 3) {
    const override = buildTier3EnvOverride('telegram', chatId);
    return Object.keys(override).length > 0 ? override : undefined;
  }
  if (tier === DEFAULT_TELEGRAM_SESSION_TIER) return undefined;
  return {
    MEMPHIS_SURFACE_TELEGRAM_MAX_TOOL_TIER: String(tier),
    MEMPHIS_SURFACE_TELEGRAM_ALLOW_URL_FETCH: 'false',
    MEMPHIS_SURFACE_TELEGRAM_ALLOW_UNKNOWN_TOOLS: 'false',
    MEMPHIS_SURFACE_TELEGRAM_ALLOW_OPERATOR_OVERRIDE: 'false',
  };
}

// ─── /tier command handler ────────────────────────────────────────────────────

async function handleTierCommand(ctx: {
  message: { chat: { id: number }; text?: string };
  reply: (text: string) => Promise<unknown>;
}): Promise<void> {
  const chatId = String(ctx.message.chat.id);
  const text = ctx.message.text ?? '';
  const parts = text.split(/\s+/);
  const arg = parts[1];

  // /tier                     → show current tier
  // /tier 0                   → safe lock-down
  // /tier 1                   → reduced operator mode
  // /tier 2                   → default companion mode
  // /tier 3 <passphrase>      → 3-hour unrestricted elevation (requires operator passphrase)
  // /tier status              → alias for no-arg
  // /tier revoke              → immediately revert to tier 2 (revokes tier 3 if active)

  if (!arg || arg === 'status') {
    const current = getSessionTier(chatId);
    if (current === 3) {
      const remainingMs = getTier3RemainingMs('telegram', chatId);
      const mins = Math.max(0, Math.round(remainingMs / 1000 / 60));
      await ctx.reply(
        `Tier: 3 (unrestricted — full filesystem mutation & sudo). Expires in ~${mins}min.\n` +
          `Use /tier revoke to end early.`,
      );
      return;
    }
    const expiresAt = sessionTierMap.get(chatId)?.expiresAt;
    const expiresIn = expiresAt ? Math.max(0, Math.round((expiresAt - Date.now()) / 1000 / 60)) : 0;
    const msg =
      current === DEFAULT_TELEGRAM_SESSION_TIER
        ? 'Tier: 2 (default full companion mode).\nUse /tier 1 for reduced mode, /tier 0 to lock down, or /tier 3 <passphrase> for 3h unrestricted mode.'
        : current === 1
          ? `Tier: 1 (reduced operator mode) — expires in ~${expiresIn}min\nUse /tier 2 to restore defaults or /tier 0 to lock down.`
          : `Tier: 0 (safe lock-down) — expires in ~${expiresIn}min\nUse /tier 2 to restore defaults.`;
    await ctx.reply(msg);
    return;
  }

  if (arg === 'revoke') {
    const wasTier3 = revokeTier3Session('telegram', chatId, 'operator-telegram-revoke');
    setSessionTier(chatId, DEFAULT_TELEGRAM_SESSION_TIER);
    await ctx.reply(
      wasTier3
        ? 'Tier 3 revoked. Back to tier 2 (default companion mode).'
        : 'Tier 2 restored (default companion mode).',
    );
    return;
  }

  const tier = Number(arg);
  if (![0, 1, 2, 3].includes(tier)) {
    await ctx.reply('Usage: /tier [0|1|2|3] (tier 3 requires operator passphrase)');
    return;
  }

  if (tier === 0) {
    setSessionTier(chatId, 0);
    await ctx.reply('Tier downgraded to 0 (safe mode).');
    return;
  }

  if (tier === 1) {
    setSessionTier(chatId, 1);
    await ctx.reply('Tier set to 1 (reduced operator mode). Expires in 15min.');
    return;
  }

  if (tier === 3) {
    const passphrase = parts.slice(2).join(' ').trim();
    if (!passphrase) {
      await ctx.reply('Tier 3 requires the operator passphrase. Usage: /tier 3 <passphrase>');
      return;
    }
    const result = requestTier3Elevation({
      surface: 'telegram',
      actorId: chatId,
      passphrase,
    });
    if (!result.ok) {
      await ctx.reply(`Tier 3 elevation denied: ${result.message}`);
      return;
    }
    const expiresAtIso = new Date(result.session.expiresAt).toISOString();
    await ctx.reply(
      `Tier 3 granted — unrestricted mutation active for 3 hours (expires ${expiresAtIso}).\n` +
        `Use /tier revoke to end early.`,
    );
    return;
  }

  // tier === 2 — an explicit legacy passphrase may be provided but is no longer required.
  const passphrase = parts.slice(2).join(' ').trim();
  if (passphrase) {
    try {
      const valid = validateOperatorPassphrase(passphrase);
      if (!valid) {
        await ctx.reply('Incorrect passphrase. Tier unchanged.');
        return;
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      await ctx.reply(`Passphrase check failed: ${msg}`);
      return;
    }
  }

  setSessionTier(chatId, DEFAULT_TELEGRAM_SESSION_TIER);
  await ctx.reply('Tier 2 restored (default full companion mode).');
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
          'Memphis agent online. Send a message to chat.\n\nCommands:\n/status — runtime status and version\n/guide — runtime design, tiers, and surface model\n/chains — chain integrity and block counts (Rust core)\n/search <query> — semantic memory search (Rust HNSW)\n/recall — what I remember about you\n/tier — companion surface tier (default 2, 1=reduced, 0=safe)\n/mode [A|B|C|D|E] — cognitive mode (A=capture, B=inferred, C=predictive, D=collective, E=meta)\n/evolve <intent> — self-modify codebase (tier 2 required, test-gated)',
        );
      });

      bot.command(['guide', 'design'], async (ctx) => {
        await ctx.reply(renderSurfaceDesignGuideText('telegram', process.env));
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
        const arg = text
          .replace(/^\/mode\s*/, '')
          .trim()
          .toUpperCase();
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
            rawEnvOverride: buildTierEnvOverride(chatId, tier),
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
        if (
          allowedIds.length > 0 &&
          (fromId === undefined || !allowedIds.includes(String(fromId)))
        ) {
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
        const rawEnvOverride = buildTierEnvOverride(chatId, sessionTier);

        recordSurfaceActivity({
          surface: 'telegram',
          actorId: userId,
          tier: sessionTier,
          telegramChatId: chatId,
        });

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
          if (
            allowedIds.length > 0 &&
            (fromId === undefined || !allowedIds.includes(String(fromId)))
          ) {
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
              rawEnvOverride: buildTierEnvOverride(chatId, sessionTier),
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
