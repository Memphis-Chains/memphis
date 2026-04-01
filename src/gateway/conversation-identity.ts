import type { ChannelName, IncomingMessage } from './chat-types.js';

const DEFAULT_LOCAL_ACTOR_ID = 'operator:local';
const PRIMARY_CONVERSATION_PREFIX = 'primary::';
const LEGACY_LOCAL_CONVERSATION_IDS = new Set(['rust-tui-default']);

function parseActorAliases(rawEnv: NodeJS.ProcessEnv): Record<string, string> {
  const raw = rawEnv.MEMPHIS_ACTOR_ALIASES_JSON?.trim();
  if (!raw) return {};

  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    return Object.fromEntries(
      Object.entries(parsed).flatMap(([key, value]) =>
        typeof value === 'string' && key.trim().length > 0 && value.trim().length > 0
          ? [[key.trim(), value.trim()]]
          : [],
      ),
    );
  } catch {
    return {};
  }
}

export function resolveActorId(
  rawActorId: string,
  rawEnv: NodeJS.ProcessEnv = process.env,
): string {
  const trimmed = rawActorId.trim();
  if (!trimmed) return DEFAULT_LOCAL_ACTOR_ID;
  return parseActorAliases(rawEnv)[trimmed] ?? trimmed;
}

export function resolveLocalActorId(rawEnv: NodeJS.ProcessEnv = process.env): string {
  const configured = rawEnv.MEMPHIS_PRIMARY_ACTOR_ID?.trim() || DEFAULT_LOCAL_ACTOR_ID;
  return resolveActorId(configured, rawEnv);
}

export function buildPrimaryConversationId(actorId: string): string {
  return `${PRIMARY_CONVERSATION_PREFIX}${actorId.trim()}`;
}

export function normalizeConversationId(
  rawConversationId: string | undefined,
  fallbackActorId: string,
  rawEnv: NodeJS.ProcessEnv = process.env,
): string {
  const trimmed = rawConversationId?.trim();
  if (!trimmed) {
    return buildPrimaryConversationId(fallbackActorId);
  }

  if (LEGACY_LOCAL_CONVERSATION_IDS.has(trimmed)) {
    return buildPrimaryConversationId(resolveLocalActorId(rawEnv));
  }

  if (trimmed.startsWith(PRIMARY_CONVERSATION_PREFIX)) {
    const rawActorId = trimmed.slice(PRIMARY_CONVERSATION_PREFIX.length).trim();
    if (!rawActorId) {
      return buildPrimaryConversationId(fallbackActorId);
    }
    return buildPrimaryConversationId(resolveActorId(rawActorId, rawEnv));
  }

  return trimmed;
}

export type ConversationContext = {
  actorId: string;
  conversationId: string;
  replyTargetId: string;
  channel: ChannelName;
};

export function deriveConversationContext(
  message: IncomingMessage,
  rawEnv: NodeJS.ProcessEnv = process.env,
): ConversationContext {
  const actorId = resolveActorId(message.actorId ?? message.userId, rawEnv);
  return {
    actorId,
    conversationId: normalizeConversationId(message.conversationId, actorId, rawEnv),
    replyTargetId: message.replyTargetId?.trim() || message.chatId,
    channel: message.channel,
  };
}
