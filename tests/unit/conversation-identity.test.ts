import { afterEach, describe, expect, it } from 'vitest';

import {
  buildPrimaryConversationId,
  deriveConversationContext,
  normalizeConversationId,
  resolveActorId,
  resolveLocalActorId,
} from '../../src/gateway/conversation-identity.js';

describe('conversation identity', () => {
  afterEach(() => {
    delete process.env.MEMPHIS_ACTOR_ALIASES_JSON;
    delete process.env.MEMPHIS_PRIMARY_ACTOR_ID;
  });

  it('builds a stable primary conversation id from actor id', () => {
    expect(buildPrimaryConversationId('telegram:42')).toBe('primary::telegram:42');
  });

  it('applies actor aliases from MEMPHIS_ACTOR_ALIASES_JSON', () => {
    process.env.MEMPHIS_ACTOR_ALIASES_JSON = JSON.stringify({
      'telegram:42': 'operator:local',
    });

    expect(resolveActorId('telegram:42')).toBe('operator:local');
  });

  it('derives actor, conversation, and reply target from an incoming message', () => {
    process.env.MEMPHIS_ACTOR_ALIASES_JSON = JSON.stringify({
      'telegram:7': 'operator:local',
    });

    const context = deriveConversationContext({
      id: 'msg-1',
      channel: 'telegram',
      userId: 'telegram:7',
      chatId: 'chat-99',
      text: 'hello',
      timestamp: new Date('2026-04-01T00:00:00.000Z'),
    });

    expect(context).toEqual({
      actorId: 'operator:local',
      conversationId: 'primary::operator:local',
      replyTargetId: 'chat-99',
      channel: 'telegram',
    });
  });

  it('resolves the local operator actor id from MEMPHIS_PRIMARY_ACTOR_ID', () => {
    process.env.MEMPHIS_PRIMARY_ACTOR_ID = 'operator:primary';
    expect(resolveLocalActorId()).toBe('operator:primary');
  });

  it('normalizes legacy local conversation ids to the canonical operator conversation', () => {
    expect(normalizeConversationId('rust-tui-default', 'telegram:42')).toBe(
      'primary::operator:local',
    );
  });

  it('normalizes aliased primary conversation ids', () => {
    process.env.MEMPHIS_ACTOR_ALIASES_JSON = JSON.stringify({
      'telegram:42': 'operator:local',
    });

    expect(normalizeConversationId('primary::telegram:42', 'telegram:42')).toBe(
      'primary::operator:local',
    );
  });
});
