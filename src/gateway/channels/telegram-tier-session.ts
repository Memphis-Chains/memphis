import { isTelegramUserAllowed } from './telegram-security.js';
import { buildTelegramTierEnvOverride, isTelegramTier2FullAccess } from './telegram-tier-policy.js';
import { validateOperatorPassphrase } from '../../infra/auth/operator-gate.js';
import {
  getActiveTier3Session,
  getTier3RemainingMs,
  requestTier3Elevation,
  revokeTier3Session,
} from '../../security/tier3-session.js';

export type TelegramOperatorContext = {
  chatId: string;
  userId: string;
  sessionTier: 0 | 1 | 2 | 3;
  rawEnvOverride?: Record<string, string>;
};

type TierSession = {
  tier: 0 | 1 | 2;
  expiresAt: number;
};

/** chatId → active tier elevation (expires after TTL or bot restart). */
const sessionTierMap = new Map<string, TierSession>();

const TIER_TTL_MS = 15 * 60 * 1000; // 15 minutes (for tiers 0/1/2)
export const DEFAULT_TELEGRAM_SESSION_TIER = 2 as const;

export function getTelegramSessionTier(chatId: string): 0 | 1 | 2 | 3 {
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

export function isAllowedTelegramUser(fromId: number | undefined, rawEnv = process.env): boolean {
  return isTelegramUserAllowed(fromId, rawEnv);
}

export function buildTelegramOperatorContext(msg: {
  chat: { id: number | string };
  from?: { id?: number };
}): TelegramOperatorContext {
  const chatId = String(msg.chat.id);
  const sessionTier = getTelegramSessionTier(chatId);
  return {
    chatId,
    userId: `telegram:${String(msg.from?.id ?? 'unknown')}`,
    sessionTier,
    rawEnvOverride: buildTelegramTierEnvOverride(chatId, sessionTier),
  };
}

// ─── /tier command handler ────────────────────────────────────────────────────

export async function handleTelegramTierCommand(ctx: {
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
    const current = getTelegramSessionTier(chatId);
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
        ? isTelegramTier2FullAccess()
          ? 'Tier: 2 (full-access companion mode: tier-3 permissions are enabled by default).\nUse /tier 1 for reduced mode or /tier 0 to lock down.'
          : 'Tier: 2 (default full companion mode).\nUse /tier 1 for reduced mode, /tier 0 to lock down, or /tier 3 <passphrase> for 3h unrestricted mode.'
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
