//
// rawEnv-threading default parameter or single-call config-source
// pattern. File-level disable per Sprint ι policy — accessor would
// add registry weight without consumer benefit.
//
import { Bot } from 'grammy';

import { registerTelegramBasicCommands } from './telegram-basic-commands.js';
import { registerTelegramCognitiveCommands } from './telegram-cognitive-commands.js';
import { registerTelegramConfigCommand } from './telegram-config-command.js';
import { deliverTelegramReply } from './telegram-delivery.js';
import { registerTelegramMediaHandlers } from './telegram-media-handlers.js';
import { registerTelegramOperationalCommands } from './telegram-operational-commands.js';
import { registerTelegramPresenceMiddleware } from './telegram-presence.js';
import { assertTelegramAccessConfigured } from './telegram-security.js';
import { registerTelegramTextTurns } from './telegram-text-turns.js';
import { subscribeTelegramTierLifecycle } from './telegram-tier-lifecycle.js';
import { getTelegramSessionTier, type TelegramOperatorContext } from './telegram-tier-session.js';
import { registerTelegramVoiceAndRestart } from './telegram-voice-handlers.js';
import type { ChannelAdapter, MessageHandler } from '../chat-types.js';
import { resolveVoiceConfig, type VoiceConfig } from '../voice/voice-service.js';

export { buildTelegramTierEnvOverride, isTelegramTier2FullAccess } from './telegram-tier-policy.js';
export {
  isTelegramModelProbe,
  isTelegramStatusProbe,
  isTelegramToolsProbe,
} from './telegram-probes.js';

export type TelegramAdapterOptions = {
  onStatus?: () => string;
  onTools?: (context: TelegramOperatorContext) => string | Promise<string>;
  onModel?: (context: TelegramOperatorContext) => string | Promise<string>;
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

export type { TelegramOperatorContext } from './telegram-tier-session.js';

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
      assertTelegramAccessConfigured(process.env);

      // S2.5 fix Bug 2: record surface activity for EVERY inbound message,
      // including slash commands. Pre-fix: only `bot.on('message:text')`
      // free-text path called recordSurfaceActivity, so `/status` reported
      // "Active surfaces: (none)" while the gateway was actively responding
      // to slash commands. This middleware runs before any handler so the
      // presence registry sees every interaction.
      registerTelegramPresenceMiddleware(bot, getTelegramSessionTier, process.env);

      registerTelegramBasicCommands(bot, options);
      registerTelegramCognitiveCommands(bot);
      registerTelegramConfigCommand(bot);
      registerTelegramOperationalCommands(bot, options, handler);
      registerTelegramTextTurns(bot, options, handler, seenChatIds);
      registerTelegramVoiceAndRestart(bot, token, handler, pendingVoiceReply);
      registerTelegramMediaHandlers(bot, token, handler);
      subscribeTelegramTierLifecycle(bot);

      void bot.start({ drop_pending_updates: true });
      started = true;
    },

    async send(chatId: string, text: string): Promise<void> {
      await deliverTelegramReply(bot, chatId, text, pendingVoiceReply, voiceConf);
    },

    async stop(): Promise<void> {
      if (started) await bot.stop();
    },
  };
}
