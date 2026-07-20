/* eslint-disable no-restricted-syntax -- config commands intentionally inspect and update the active environment */
import type { Bot } from 'grammy';

import { parseTelegramAllowedUserIds } from './telegram-readiness.js';
import { isTelegramTier2FullAccess } from './telegram-tier-policy.js';
import { getTelegramSessionTier } from './telegram-tier-session.js';
import { setDotEnvValues } from '../../infra/config/dotenv-file.js';
import { performHotReload, redactFieldValue } from '../../infra/config/hot-reload.js';
import {
  classifyField,
  listKnownFields,
  requiresElevatedTier,
  requiresRestart,
} from '../../infra/config/mutability.js';
import { envSchema } from '../../infra/config/schema.js';

export function registerTelegramConfigCommand(bot: Bot): void {
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
    if (allowedIds.length > 0 && (fromId === undefined || !allowedIds.includes(String(fromId)))) {
      await ctx.reply('Access denied.');
      return;
    }
    const chatId = String(msg.chat.id);
    const tier = getTelegramSessionTier(chatId);
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
      if (requiresElevatedTier(key) && tier < 3 && !isTelegramTier2FullAccess()) {
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
}
