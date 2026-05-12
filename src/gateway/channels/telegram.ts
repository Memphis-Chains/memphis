/* eslint-disable no-restricted-syntax */
//
// rawEnv-threading default parameter or single-call config-source
// pattern. File-level disable per Sprint ι policy — accessor would
// add registry weight without consumer benefit.
//
import { Bot, InputFile } from 'grammy';

import { parseTelegramAllowedUserIds, telegramAllowAllUsers } from './telegram-readiness.js';
import { splitText } from './utils.js';
import { getCognitiveModeConfig, isValidCognitiveMode } from '../../cognitive/modes.js';
import { recordSurfaceActivity } from '../../core/surface-presence.js';
import { validateOperatorPassphrase } from '../../infra/auth/operator-gate.js';
import { setDotEnvValues } from '../../infra/config/dotenv-file.js';
import { performHotReload, redactFieldValue } from '../../infra/config/hot-reload.js';
import {
  classifyField,
  listKnownFields,
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
  subscribeTier3Lifecycle,
} from '../../security/tier3-session.js';
import { getCognitiveMode, setCognitiveMode } from '../../soul/manifest.js';
import type { ChannelAdapter, MessageHandler } from '../chat-types.js';
import { ingestMedia } from '../media/orchestrator.js';
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
    // Critical: `getSessionTier` checks tier-3 first, so without this
    // revoke the /tier 0 command replies "downgraded" while effective
    // permissions stay at tier 3 until the session TTL expires.
    const wasTier3 = revokeTier3Session('telegram', chatId, 'operator-telegram-tier-downgrade');
    setSessionTier(chatId, 0);
    await ctx.reply(
      wasTier3
        ? 'Tier 3 revoked AND tier downgraded to 0 (safe mode).'
        : 'Tier downgraded to 0 (safe mode).',
    );
    return;
  }

  if (tier === 1) {
    const wasTier3 = revokeTier3Session('telegram', chatId, 'operator-telegram-tier-downgrade');
    setSessionTier(chatId, 1);
    await ctx.reply(
      wasTier3
        ? 'Tier 3 revoked AND tier set to 1 (reduced operator mode). Expires in 15min.'
        : 'Tier set to 1 (reduced operator mode). Expires in 15min.',
    );
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

  // /tier 2 must revoke any active tier-3 too; otherwise the same
  // misleading-downgrade bug as /tier 0|1 (Codex P1 on PR #77).
  const wasTier3 = revokeTier3Session('telegram', chatId, 'operator-telegram-tier-downgrade');
  setSessionTier(chatId, DEFAULT_TELEGRAM_SESSION_TIER);
  await ctx.reply(
    wasTier3
      ? 'Tier 3 revoked AND tier 2 restored (default full companion mode).'
      : 'Tier 2 restored (default full companion mode).',
  );
}

// ─── TTS shaping (2026-05-11) ────────────────────────────────────────────────

/**
 * Operator policy for Telegram voice replies:
 * - Max 5-7 sentences (sentence-based, not char-based — char truncation
 *   often clipped mid-word and made the voice cut off awkwardly).
 * - If the original reply was longer, the voice itself announces
 *   "reszta w tekście" so the listener knows to switch to text.
 * - Strip markdown / special chars Piper would read aloud verbatim
 *   (asterisks, underscores, code fences, link brackets, raw URLs).
 *
 * Returns the synthesizable text — caller pipes it straight to Piper.
 */
const TTS_MAX_SENTENCES = 6;

function buildTtsReplyText(fullText: string): string {
  const sanitized = sanitizeForTts(fullText);
  // Split on sentence boundaries — covers Polish "Czy to?" and "tak.",
  // keeps the punctuation attached. Non-greedy capture handles
  // "...takich." correctly (ellipsis as one terminator, not three).
  const parts = sanitized.match(/[^.!?…]+[.!?…]+\s*/g) ?? [sanitized];
  if (parts.length <= TTS_MAX_SENTENCES) {
    return sanitized.trim();
  }
  const head = parts.slice(0, TTS_MAX_SENTENCES).join('').trim();
  return `${head} Reszta w tekście.`;
}

function sanitizeForTts(text: string): string {
  return (
    text
      // Strip fenced code blocks entirely — Piper reading code symbol
      // by symbol is the operator complaint we're fixing.
      .replace(/```[\s\S]*?```/g, ' (blok kodu) ')
      // Inline code: keep the contents, drop the backticks.
      .replace(/`([^`]+)`/g, '$1')
      // Bold/italic markdown markers — keep text, drop * and _.
      .replace(/(\*\*|__)(.*?)\1/g, '$2')
      .replace(/(\*|_)(.*?)\1/g, '$2')
      // Markdown links [text](url) → text only (URL would be read char by char).
      .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
      // Bare URLs — collapse to "link" so Piper doesn't enunciate the protocol.
      .replace(/https?:\/\/\S+/g, 'link')
      // Headings / list bullets / blockquote markers.
      .replace(/^#{1,6}\s+/gm, '')
      .replace(/^[\s]*[-*+]\s+/gm, '')
      .replace(/^>\s+/gm, '')
      // Emoji + variation-selector + zero-width — Piper trips on these
      // (reads them as "okrąg pomarańczowy" or worse, garbled). Each
      // class isolated so eslint's no-misleading-character-class lints
      // cleanly (literal combining marks would re-form sequences).
      .replace(/[\u{1F300}-\u{1FAFF}]/gu, '')
      .replace(/[\u{2600}-\u{27BF}]/gu, '')
      .replace(/\u{200B}|\u{200C}|\u{200D}|\u{FE0F}/gu, '')
      // Collapse runs of whitespace.
      .replace(/\s+/g, ' ')
      .trim()
  );
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
      // Security gate: refuse to start the gateway with no allowlist AND no
      // explicit opt-in. The in-chat gates below only filter when the
      // allowlist is non-empty, so an empty list used to silently accept
      // every Telegram user that found the token. Fail loud at start time
      // so the operator has to consciously choose `--allowed-user-ids` or
      // `MEMPHIS_TELEGRAM_ALLOW_ALL=1`.
      const allowedAtBoot = parseTelegramAllowedUserIds(process.env);
      const allowAllAtBoot = telegramAllowAllUsers(process.env);
      if (allowedAtBoot.length === 0 && !allowAllAtBoot) {
        throw new Error(
          'Refusing to start Telegram gateway: allowlist is empty and ' +
            'MEMPHIS_TELEGRAM_ALLOW_ALL is not set. Either ' +
            'set MEMPHIS_TELEGRAM_ALLOWED_USER_IDS=<csv of user ids> in .env ' +
            '(preferred) or explicitly opt into open access with ' +
            'MEMPHIS_TELEGRAM_ALLOW_ALL=1 (ONLY for solo-operator sandboxes ' +
            'where the bot token is not shared). Re-run `memphis setup telegram ' +
            '--allowed-user-ids <ids>` to configure.',
        );
      }
      if (allowedAtBoot.length === 0 && allowAllAtBoot) {
        console.warn(
          '[telegram] MEMPHIS_TELEGRAM_ALLOW_ALL=1 and allowlist empty — ' +
            'the bot will accept messages from every Telegram user. ' +
            'This is a single-operator sandbox opt-in; do not use in production.',
        );
      }

      // S2.5 fix Bug 2: record surface activity for EVERY inbound message,
      // including slash commands. Pre-fix: only `bot.on('message:text')`
      // free-text path called recordSurfaceActivity, so `/status` reported
      // "Active surfaces: (none)" while the gateway was actively responding
      // to slash commands. This middleware runs before any handler so the
      // presence registry sees every interaction.
      bot.use(async (ctx, next) => {
        const fromId = ctx.from?.id;
        const chatId = ctx.chat?.id;
        // Codex P2 fix on PR #285: gate activity tracking behind the
        // same allowlist the message handlers use. Without this, every
        // unauthorized ping (random user, scraper) would inflate the
        // surface-presence registry as if the gateway were serving them.
        if (chatId !== undefined) {
          const allowedIds = parseTelegramAllowedUserIds(process.env);
          const fromAllowed =
            allowedIds.length === 0 ||
            (fromId !== undefined && allowedIds.includes(String(fromId)));
          if (fromAllowed) {
            recordSurfaceActivity({
              surface: 'telegram',
              actorId: `telegram:${String(fromId ?? 'unknown')}`,
              tier: getSessionTier(String(chatId)),
              telegramChatId: String(chatId),
            });
          }
        }
        await next();
      });

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

      bot.command('config', async (ctx) => {
        const msg = ctx.message;
        if (!msg) return;
        // Allowlist gate — matches message:text / message:voice. Without this,
        // any chat reachable by the bot token could execute /config show /
        // /config set / /config reload. When the allowlist is empty
        // (MEMPHIS_TELEGRAM_ALLOWED_USER_IDS unset), skip — operator has
        // explicitly disabled the list. When populated, enforce strictly.
        const allowedIds = parseTelegramAllowedUserIds(process.env);
        const fromId = msg.from?.id;
        if (
          allowedIds.length > 0 &&
          (fromId === undefined || !allowedIds.includes(String(fromId)))
        ) {
          await ctx.reply('Access denied.');
          return;
        }
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
          // Codex P1 fix: enumerate listKnownFields() instead of all of
          // process.env, and reject single-key requests that aren't on the
          // whitelist. Otherwise unrelated env vars (legacy operator
          // credentials, host-side secrets, etc.) get echoed verbatim
          // because redactFieldValue only masks keys it knows are secret.
          const known = listKnownFields();
          const knownKeySet = new Set(known.map((f) => f.key));
          const key = remainder || null;
          if (key) {
            if (!knownKeySet.has(key)) {
              await ctx.reply(
                `Unknown config key: ${key}. /config show only exposes keys defined in envSchema. ` +
                  `Use /config show (no key) to list them.`,
              );
              return;
            }
            const value = process.env[key];
            await ctx.reply(
              value === undefined
                ? `${key} is unset.`
                : `${key}=${redactFieldValue(key, value)} (tier=${classifyField(key)})`,
            );
          } else {
            const lines: string[] = ['Config fields (redacted):'];
            for (const field of known) {
              const raw = process.env[field.key];
              if (raw === undefined) continue;
              lines.push(`  ${field.key}=${redactFieldValue(field.key, raw)} (${field.tier})`);
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
            await ctx.reply(
              `${key} is a secret field — tier 3 required.\nUse: /tier 3 <passphrase>`,
            );
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
          await ctx.reply(
            `${key}=${redactFieldValue(key, value)} applied (tier=${classifyField(key)}).`,
          );
          return;
        }
        if (verb === 'reload') {
          const result = await performHotReload();
          if (!result.ok) {
            if (result.validationError) {
              await ctx.reply(`Reload blocked: ${result.validationError}`);
            } else if (result.rejectedCold.length > 0) {
              await ctx.reply(
                `Reload blocked — cold fields require restart:\n${result.rejectedCold.join(', ')}`,
              );
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

        // (Surface activity already recorded by the global middleware above —
        // S2.5 Bug 2 fix: every inbound message goes through there now.)

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

      bot.command('restart', async (ctx) => {
        const msg = ctx.message;
        if (!msg) return;
        const chatId = String(msg.chat.id);
        const tier = getSessionTier(chatId);
        if (tier < 3) {
          await ctx.reply('Restart requires tier 3.\nUse: /tier 3 <passphrase>');
          return;
        }
        const reason = (msg.text ?? '').replace(/^\/restart\s*/, '').trim() || undefined;
        const { requestRestart } = await import('../../infra/runtime/self-restart.js');
        const outcome = await requestRestart({
          surface: 'telegram',
          actorId: chatId,
          reason,
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

      // Photo handler — runs B3 vision pipeline server-side and
      // injects the description into the bot's text brief. Server-side
      // (not "let the bot call memphis_media_ingest") because the tool
      // is tier-2-gated and the chat surface defaults to tier 2 — but
      // also because deterministic ingest avoids the bot deciding not
      // to look at the image. The honest-fallback brief from Sprint 3.1
      // still kicks in if vision fails (no Ollama vision model, network
      // hiccup, etc.) — the runtime never lies about its capabilities.
      bot.on('message:photo', async (ctx) => {
        const msg = ctx.message;
        if (!msg.photo || msg.from?.is_bot) return;

        const allowedIds = parseTelegramAllowedUserIds(process.env);
        const fromId = msg.from?.id;
        if (
          allowedIds.length > 0 &&
          (fromId === undefined || !allowedIds.includes(String(fromId)))
        ) {
          await ctx.reply('Access denied.');
          return;
        }

        const largest = msg.photo[msg.photo.length - 1];
        const caption = msg.caption?.trim() ?? '';
        const fileId = largest.file_id;

        const chatId = String(msg.chat.id);
        const userId = `telegram:${String(msg.from?.id ?? 'unknown')}`;
        const sessionTier = getSessionTier(chatId);

        const captionFragment = caption.length > 0 ? `caption: "${caption}"` : 'no caption';

        let visionDescription = '';
        let visionError = '';
        let ocrText = '';
        let ocrConfidence = 0;
        let tempPath = '';
        try {
          const file = await ctx.api.getFile(fileId);
          const fileUrl = `https://api.telegram.org/file/bot${token}/${file.file_path}`;
          const photoResponse = await fetch(fileUrl);
          if (!photoResponse.ok) {
            throw new Error(`Telegram file download failed: ${photoResponse.status}`);
          }
          const photoBuffer = Buffer.from(await photoResponse.arrayBuffer());
          const os = await import('node:os');
          const fs = await import('node:fs/promises');
          const path = await import('node:path');
          const ext = (file.file_path?.match(/\.[a-z0-9]+$/i)?.[0] ?? '.jpg').toLowerCase();
          tempPath = path.join(os.tmpdir(), `tg-photo-${msg.message_id}-${Date.now()}${ext}`);
          await fs.writeFile(tempPath, photoBuffer);
          const result = await ingestMedia(tempPath, { kind: 'image', surface: 'telegram' }, process.env);
          if (result.error) {
            visionError = result.error;
          } else if (result.payload.kind === 'image') {
            visionDescription = result.payload.description;
            ocrText = result.payload.ocrText ?? '';
            ocrConfidence = result.payload.ocrConfidence ?? 0;
          }
        } catch (err) {
          visionError = err instanceof Error ? err.message : String(err);
        } finally {
          if (tempPath) {
            const fs = await import('node:fs/promises');
            await fs.unlink(tempPath).catch(() => {});
          }
        }

        // Sprint ζ: include OCR text when Tesseract returned non-empty
        // with reasonable confidence. < 0.5 confidence text usually
        // means the image had little/no real writing — quote it but
        // mark it low-confidence so the bot doesn't over-anchor.
        const ocrLine =
          ocrText.length > 0
            ? `\n[OCR-extracted text via Tesseract, confidence ${(ocrConfidence * 100).toFixed(0)}%]\n"${ocrText.slice(0, 1500)}"`
            : '';
        const baseHeader = `[Telegram attachment: photo (${captionFragment}, width=${largest.width ?? '?'}, height=${largest.height ?? '?'}, file_id=${fileId})]`;
        const attachmentBrief = visionDescription
          ? `${baseHeader} Vision pipeline already described the image: "${visionDescription}".${ocrLine} ` +
            `Use the description AND the OCR text as ground truth — both were produced by the runtime before this turn. Do not claim you ran any tool.`
          : `${baseHeader} Vision pipeline error (${visionError || 'unknown'}).${ocrLine} ` +
            `Acknowledge the attachment honestly, ask the user what they'd like described, do not invent image contents.`;

        try {
          await handler({
            id: String(msg.message_id),
            channel: 'telegram',
            userId,
            chatId,
            text: attachmentBrief,
            timestamp: new Date(msg.date * 1000),
            rawEnvOverride: buildTierEnvOverride(chatId, sessionTier),
          });
        } catch (err) {
          const errMsg = err instanceof Error ? err.message : String(err);
          await ctx.reply(`Błąd obsługi zdjęcia: ${errMsg.slice(0, 200)}`);
        }
      });

      // Document attachments — PDFs / text files / structured data.
      // Operator forwards a faktura, an article, or a log dump and
      // expects Memphis to read it. PDFs go through pdftotext (poppler
      // — Memphis-compatible Apache-license native tool already on the
      // typical install), plain text / markdown / json / csv read raw,
      // images uploaded as documents (some clients route screenshots
      // this way) reuse the existing vision pipeline so the user
      // experience is identical regardless of how the photo arrived.
      // Anything else is acknowledged honestly without invented contents.
      bot.on('message:document', async (ctx) => {
        const msg = ctx.message;
        if (!msg.document || msg.from?.is_bot) return;

        const allowedIds = parseTelegramAllowedUserIds(process.env);
        const fromId = msg.from?.id;
        if (
          allowedIds.length > 0 &&
          (fromId === undefined || !allowedIds.includes(String(fromId)))
        ) {
          await ctx.reply('Access denied.');
          return;
        }

        const doc = msg.document;
        const mime = (doc.mime_type ?? '').toLowerCase();
        const filename = doc.file_name ?? `attachment-${msg.message_id}`;
        const caption = msg.caption?.trim() ?? '';
        const captionFragment = caption.length > 0 ? `caption: "${caption}"` : 'no caption';
        const sizeBytes = doc.file_size ?? 0;
        const chatId = String(msg.chat.id);
        const userId = `telegram:${String(msg.from?.id ?? 'unknown')}`;
        const sessionTier = getSessionTier(chatId);

        // Hard ceiling — Telegram lets bots fetch up to ~20 MB; refuse
        // anything bigger before paying the download cost. 10 MB chosen
        // as a practical limit (huge PDFs are rarely the operator's
        // intent and would blow up the prompt token budget anyway).
        const SIZE_LIMIT = 10 * 1024 * 1024;
        if (sizeBytes > SIZE_LIMIT) {
          await ctx.reply(
            `Plik za duży (${(sizeBytes / 1024 / 1024).toFixed(1)} MB > 10 MB). ` +
              'Wyślij krótszy fragment albo wgraj go bezpośrednio do ~/memphis/data/.',
          );
          return;
        }

        await ctx.replyWithChatAction('typing');

        let extractedText = '';
        let extractionError = '';
        let extractionMode: 'pdf' | 'text' | 'image-via-vision' | 'unsupported' = 'unsupported';
        let tempPath = '';
        let visionDescription = '';
        let ocrText = '';
        let ocrConfidence = 0;

        try {
          const file = await ctx.api.getFile(doc.file_id);
          const fileUrl = `https://api.telegram.org/file/bot${token}/${file.file_path}`;
          const fileResponse = await fetch(fileUrl);
          if (!fileResponse.ok) {
            throw new Error(`Telegram file download failed: ${fileResponse.status}`);
          }
          const fileBuffer = Buffer.from(await fileResponse.arrayBuffer());
          const os = await import('node:os');
          const fs = await import('node:fs/promises');
          const path = await import('node:path');
          const ext = (filename.match(/\.[a-z0-9]+$/i)?.[0] ?? '').toLowerCase();
          tempPath = path.join(os.tmpdir(), `tg-doc-${msg.message_id}-${Date.now()}${ext}`);
          await fs.writeFile(tempPath, fileBuffer);

          const isPdf = mime === 'application/pdf' || ext === '.pdf';
          const isImage = mime.startsWith('image/') || ['.jpg', '.jpeg', '.png', '.webp', '.gif'].includes(ext);
          const isPlainText =
            mime.startsWith('text/') ||
            ['.txt', '.md', '.json', '.csv', '.log', '.yaml', '.yml', '.toml', '.xml', '.tsv'].includes(ext);

          if (isPdf) {
            extractionMode = 'pdf';
            const { spawn } = await import('node:child_process');
            extractedText = await new Promise<string>((resolve, reject) => {
              const child = spawn('pdftotext', ['-layout', '-q', '-enc', 'UTF-8', tempPath, '-']);
              const chunks: Buffer[] = [];
              let stderr = '';
              child.stdout.on('data', (c: Buffer) => chunks.push(c));
              child.stderr.on('data', (c: Buffer) => (stderr += c.toString()));
              child.on('error', (err) => reject(err));
              child.on('close', (code) => {
                if (code !== 0) {
                  reject(new Error(`pdftotext exit=${code}: ${stderr.slice(0, 200)}`));
                  return;
                }
                resolve(Buffer.concat(chunks).toString('utf-8'));
              });
            });
          } else if (isPlainText) {
            extractionMode = 'text';
            // Cap raw read at 256 KB — beyond that the prompt budget
            // breaks even with truncation downstream.
            const TEXT_CAP = 256 * 1024;
            extractedText = fileBuffer.subarray(0, TEXT_CAP).toString('utf-8');
            if (fileBuffer.length > TEXT_CAP) {
              extractedText += `\n\n[…truncated; original ${(fileBuffer.length / 1024).toFixed(1)} KB, showing first 256 KB]`;
            }
          } else if (isImage) {
            extractionMode = 'image-via-vision';
            const result = await ingestMedia(
              tempPath,
              { kind: 'image', surface: 'telegram' },
              process.env,
            );
            if (result.error) {
              extractionError = result.error;
            } else if (result.payload.kind === 'image') {
              visionDescription = result.payload.description;
              ocrText = result.payload.ocrText ?? '';
              ocrConfidence = result.payload.ocrConfidence ?? 0;
            }
          } else {
            extractionMode = 'unsupported';
            extractionError = `mime=${mime || 'unknown'} ext=${ext || 'none'}`;
          }
        } catch (err) {
          extractionError = err instanceof Error ? err.message : String(err);
        } finally {
          if (tempPath) {
            const fs = await import('node:fs/promises');
            await fs.unlink(tempPath).catch(() => {});
          }
        }

        // Build the LLM-facing attachment brief. Mirrors the photo
        // handler's anti-hallucination guardrail: stamp WHO did the
        // extraction (poppler / tesseract / vision LLM) and tell the
        // model to use it as ground truth, not invent contents.
        const baseHeader =
          `[Telegram attachment: document filename="${filename}" mime="${mime || 'unknown'}" ` +
          `size=${sizeBytes}b ${captionFragment}]`;

        let attachmentBrief: string;
        if (extractionMode === 'pdf' && extractedText.length > 0) {
          // Cap PDF text in the prompt at 12 KB — model context budget
          // is finite and most operator-forwarded PDFs are <2 pages of
          // useful content. Operator can re-send a specific page or
          // section if more is needed.
          const PDF_PROMPT_CAP = 12 * 1024;
          const body =
            extractedText.length > PDF_PROMPT_CAP
              ? extractedText.slice(0, PDF_PROMPT_CAP) +
                `\n\n[…PDF truncated at ${PDF_PROMPT_CAP} chars; original ${extractedText.length} chars total]`
              : extractedText;
          attachmentBrief =
            `${baseHeader} pdftotext extracted ${extractedText.length} chars. Treat the body below as ` +
            `ground truth from the runtime; do not claim you ran any tool yourself.\n\n` +
            `--- DOCUMENT BODY ---\n${body}\n--- END BODY ---`;
        } else if (extractionMode === 'text' && extractedText.length > 0) {
          attachmentBrief =
            `${baseHeader} Read as utf-8 text (${extractedText.length} chars). Body below.\n\n` +
            `--- DOCUMENT BODY ---\n${extractedText}\n--- END BODY ---`;
        } else if (extractionMode === 'image-via-vision' && visionDescription) {
          const ocrLine =
            ocrText.length > 0
              ? `\n[OCR-extracted text via Tesseract, confidence ${(ocrConfidence * 100).toFixed(0)}%]\n"${ocrText.slice(0, 1500)}"`
              : '';
          attachmentBrief =
            `${baseHeader} Image-as-document — vision pipeline already described: "${visionDescription}".${ocrLine} ` +
            `Use the description AND the OCR text as ground truth — both were produced by the runtime before this turn.`;
        } else {
          attachmentBrief =
            `${baseHeader} Extraction unavailable (${extractionError || 'unsupported file type'}). ` +
            `Acknowledge the attachment honestly, ask the user what they need from it, do not invent contents.`;
        }

        try {
          await handler({
            id: String(msg.message_id),
            channel: 'telegram',
            userId,
            chatId,
            text: attachmentBrief,
            timestamp: new Date(msg.date * 1000),
            rawEnvOverride: buildTierEnvOverride(chatId, sessionTier),
          });
        } catch (err) {
          const errMsg = err instanceof Error ? err.message : String(err);
          await ctx.reply(`Błąd obsługi dokumentu: ${errMsg.slice(0, 200)}`);
        }
      });

      // Sprint ν: subscribe to tier-3 lifecycle so the operator gets
      // an active warning + final notification on Telegram instead of
      // discovering the expiry only on the next denied action.
      subscribeTier3Lifecycle((event) => {
        if (event.session.surface !== 'telegram') return;
        const chatId = event.session.actorId;
        const remainingMin = 'remainingMs' in event ? Math.round(event.remainingMs / 60_000) : 0;
        const text =
          event.kind === 'expiring-soon'
            ? `⏰ Tier 3 wygasa za ~${remainingMin} min. Jeśli chcesz kontynuować, ` +
              'odpal `/tier 3 <pass>` lub poczekaj na koniec.'
            : event.kind === 'expired'
              ? '⚠ Tier 3 wygasł. Wracam do tier 2 (chat surface). ' +
                'Aby ponownie odblokować — `/tier 3 <pass>`.'
              : `↩ Tier 3 cofnięty (${event.reason}). Jesteś na tier 2.`;
        bot.api.sendMessage(chatId, text).catch(() => {
          // Best-effort — operator may have blocked the bot or chat
          // may be gone. Lifecycle audit log already captured the
          // event so we don't lose state.
        });
      });

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
          // Voice reply policy (operator decision 2026-05-11):
          // - 5-7 sentences max — voice should be quick TL;DR, not full text
          // - if truncated, the voice itself says "reszta w tekście" so the
          //   user knows they need to read the chat for the full answer
          // - sanitize markdown / special chars Piper would otherwise
          //   read aloud verbatim ("gwiazdka", "podkreślnik", URLs...)
          const ttsText = buildTtsReplyText(trimmed);
          const ttsResult = await textToSpeech(ttsText, voiceConf);
          if (!ttsResult.error && ttsResult.audio.length > 0) {
            // Codex P1 fix (PR #91): charge the quota the moment the paid
            // TTS call returns successfully — BEFORE attempting Telegram
            // delivery. Charging after sendVoice meant a Telegram delivery
            // failure left the paid synth uncharged, so the per-chat daily
            // cap stopped limiting provider spend in exactly the failure
            // mode it was meant to bound. The audio bytes are what cost
            // money; delivery is best-effort on top.
            consumeTtsQuota(chatId);
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
