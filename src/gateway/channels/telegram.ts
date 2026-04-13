import { Bot, InputFile } from 'grammy';

import { parseTelegramAllowedUserIds } from './telegram-readiness.js';
import { splitText } from './utils.js';
import { getCognitiveModeConfig, isValidCognitiveMode } from '../../cognitive/modes.js';
import { recordSurfaceActivity } from '../../core/surface-presence.js';
import { validateOperatorPassphrase } from '../../infra/auth/operator-gate.js';
import { setDotEnvValues } from '../../infra/config/dotenv-file.js';
import {
  performHotReload,
  redactFieldValue,
} from '../../infra/config/hot-reload.js';
import {
  classifyField,
  requiresElevatedTier,
  requiresRestart,
} from '../../infra/config/mutability.js';
import { envSchema } from '../../infra/config/schema.js';
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
  checkTtsQuota,
  consumeTtsQuota,
  getVoicePreference,
  setVoicePreference,
} from '../voice/voice-policy.js';
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
          [
            'Memphis agent online. Send a message to chat.',
            '',
            'Commands:',
            '/status — runtime status, version, and cross-surface presence (TUI/Telegram/HTTP)',
            '/guide — runtime design, tiers, and surface model',
            '/chains — chain integrity and block counts (Rust core)',
            '/search <query> — semantic memory search (Rust HNSW)',
            '/recall — what I remember about you',
            '/tier — companion surface tier (default 2, 1=reduced, 0=safe; tier 3 needs passphrase)',
            '/mode [A|B|C|D|E] — cognitive mode (A=capture, B=inferred, C=predictive, D=collective, E=meta)',
            '/config show|set|reload — show or change runtime config on the fly (tier 3 for secrets)',
            '/voice on|off|status — toggle TTS replies and view today\'s quota',
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

      bot.command('config', async (ctx) => {
        const msg = ctx.message;
        if (!msg) return;
        const chatId = String(msg.chat.id);
        const tier = getSessionTier(chatId);
        if (tier < 2) {
          await ctx.reply('Config commands require tier 2.\nUse: /tier 2');
          return;
        }
        const text = (msg.text ?? '').replace(/^\/config\s*/, '').trim();
        if (!text || text === 'help') {
          await ctx.reply(
            [
              'Usage:',
              '/config show [KEY]              — show one or all known fields (redacted)',
              '/config set KEY=VALUE           — write to .env and process.env (tier-3 for secrets)',
              '/config reload                  — re-read .env, swap hot/warm fields, refuse cold',
            ].join('\n'),
          );
          return;
        }
        const [verb, ...rest] = text.split(/\s+/);
        const remainder = rest.join(' ').trim();
        if (verb === 'show') {
          const key = remainder || null;
          if (key) {
            const value = process.env[key];
            await ctx.reply(
              value === undefined
                ? `${key} is unset.`
                : `${key}=${redactFieldValue(key, value)} (tier=${classifyField(key)})`,
            );
          } else {
            const lines: string[] = ['Config fields (redacted):'];
            for (const [name, raw] of Object.entries(process.env)) {
              if (raw === undefined) continue;
              const tierLabel = classifyField(name);
              if (tierLabel === 'cold' && !(name in process.env)) continue;
              lines.push(`  ${name}=${redactFieldValue(name, raw)} (${tierLabel})`);
              if (lines.length > 60) {
                lines.push(`  ...truncated, use /config show <KEY> for specifics`);
                break;
              }
            }
            await ctx.reply(lines.join('\n'));
          }
          return;
        }
        if (verb === 'set') {
          const eq = remainder.indexOf('=');
          if (eq <= 0) {
            await ctx.reply('Usage: /config set KEY=VALUE');
            return;
          }
          const key = remainder.slice(0, eq).trim();
          const value = remainder.slice(eq + 1);
          if (value.includes('\n') || value.includes('\r')) {
            await ctx.reply('value must not contain newline characters');
            return;
          }
          if (requiresRestart(key)) {
            await ctx.reply(`${key} is a cold field — restart required; refused.`);
            return;
          }
          if (requiresElevatedTier(key) && tier < 3) {
            await ctx.reply(`${key} is a secret field — tier 3 required.\nUse: /tier 3 <passphrase>`);
            return;
          }
          const candidate = { ...process.env, [key]: value };
          const parsed = envSchema.partial().safeParse(candidate);
          if (!parsed.success) {
            const issue = parsed.error.issues.find((i) => i.path.includes(key));
            await ctx.reply(`Validation failed for ${key}: ${issue?.message ?? 'invalid value'}`);
            return;
          }
          setDotEnvValues({ [key]: value }, process.env);
          process.env[key] = value;
          await ctx.reply(`${key}=${redactFieldValue(key, value)} applied (tier=${classifyField(key)}).`);
          return;
        }
        if (verb === 'reload') {
          const result = await performHotReload();
          if (!result.ok) {
            if (result.validationError) {
              await ctx.reply(`Reload blocked: ${result.validationError}`);
            } else if (result.rejectedCold.length > 0) {
              await ctx.reply(`Reload blocked — cold fields require restart:\n${result.rejectedCold.join(', ')}`);
            } else {
              await ctx.reply('Reload blocked.');
            }
            return;
          }
          await ctx.reply(
            `Reload OK: applied=${result.appliedCount}, unchanged=${result.unchangedCount}.`,
          );
          return;
        }
        await ctx.reply(`Unknown /config verb: ${verb}. Try /config help.`);
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

      bot.command('voice', async (ctx) => {
        const msg = ctx.message;
        if (!msg) return;
        const chatId = String(msg.chat.id);
        const arg = (msg.text ?? '').replace(/^\/voice\s*/, '').trim().toLowerCase();
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
      // If this was a voice message, also send TTS audio reply (quota-gated)
      if (pendingVoiceReply.has(chatId) && voiceConf) {
        const quota = checkTtsQuota(chatId);
        if (!quota.allowed) {
          if (quota.reason === 'daily_limit_reached') {
            try {
              await bot.api.sendMessage(
                chatId,
                `(voice reply skipped — daily TTS limit ${quota.used}/${quota.limit} reached; resets at UTC midnight)`,
              );
            } catch {
              // best-effort notice
            }
          }
          // preference_off / limit_disabled stay silent — operator opted in
          return;
        }
        try {
          // Truncate to ~500 chars for TTS (voice messages should be concise)
          const ttsText = trimmed.length > 500 ? trimmed.slice(0, 497) + '...' : trimmed;
          const ttsResult = await textToSpeech(ttsText, voiceConf);
          if (!ttsResult.error && ttsResult.audio.length > 0) {
            await bot.api.sendVoice(chatId, new InputFile(ttsResult.audio, 'reply.ogg'));
            consumeTtsQuota(chatId);
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
