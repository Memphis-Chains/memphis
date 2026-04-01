import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  deriveConversationContext,
  normalizeConversationId,
  resolveLocalActorId,
} from '../../src/gateway/conversation-identity.js';
import { createOperatorChatSessionStore } from '../../src/gateway/operator-chat-session-store.js';
import { createSqliteClient, runMigrations } from '../../src/infra/storage/sqlite/client.js';
import { SqliteOperatorChatSessionRepository } from '../../src/infra/storage/sqlite/repositories/operator-chat-session-repository.js';

describe('cross-surface conversation continuity', () => {
  afterEach(() => {
    delete process.env.MEMPHIS_ACTOR_ALIASES_JSON;
    delete process.env.MEMPHIS_PRIMARY_ACTOR_ID;
  });

  it('converges aliased telegram traffic and local operator turns into one primary conversation', () => {
    process.env.MEMPHIS_ACTOR_ALIASES_JSON = JSON.stringify({
      'telegram:7': 'operator:local',
    });

    const dir = mkdtempSync(join(tmpdir(), 'memphis-cross-surface-continuity-'));
    const db = createSqliteClient(`file:${join(dir, 'runtime.db')}`);
    runMigrations(db);

    try {
      const repo = new SqliteOperatorChatSessionRepository(db);
      const store = createOperatorChatSessionStore(repo);

      const telegramConversation = deriveConversationContext({
        id: 'msg-telegram-1',
        channel: 'telegram',
        userId: 'telegram:7',
        chatId: 'chat-7',
        text: 'telegram says hello',
        timestamp: new Date('2026-04-01T12:00:00.000Z'),
      });
      const localActorId = resolveLocalActorId(process.env);
      const localConversationId = normalizeConversationId(
        'rust-tui-default',
        localActorId,
        process.env,
      );

      expect(telegramConversation.actorId).toBe(localActorId);
      expect(telegramConversation.conversationId).toBe(localConversationId);

      store.append(
        telegramConversation.conversationId,
        'telegram says hello',
        'assistant replies in telegram',
        {
          channel: 'telegram',
          actorId: telegramConversation.actorId,
          conversationId: telegramConversation.conversationId,
          replyTargetId: telegramConversation.replyTargetId,
        },
      );
      store.append(localConversationId, 'local operator follows up', 'assistant answers locally', {
        channel: 'terminal',
        actorId: localActorId,
        conversationId: localConversationId,
      });

      expect(store.get(localConversationId)).toEqual([
        { role: 'user', content: 'telegram says hello' },
        { role: 'assistant', content: 'assistant replies in telegram' },
        { role: 'user', content: 'local operator follows up' },
        { role: 'assistant', content: 'assistant answers locally' },
      ]);

      expect(repo.listMessages(localConversationId, 10)).toEqual([
        expect.objectContaining({
          role: 'user',
          content: 'telegram says hello',
          provider: 'telegram',
        }),
        expect.objectContaining({
          role: 'assistant',
          content: 'assistant replies in telegram',
          provider: 'telegram',
        }),
        expect.objectContaining({
          role: 'user',
          content: 'local operator follows up',
          provider: 'terminal',
        }),
        expect.objectContaining({
          role: 'assistant',
          content: 'assistant answers locally',
          provider: 'terminal',
        }),
      ]);
      expect(repo.listMessages('primary::telegram:7', 10)).toEqual([]);
    } finally {
      db.close();
    }
  });
});
