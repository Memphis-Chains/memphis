import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { ConversationContextService } from '../../src/gateway/conversation-context-service.js';
import { createSqliteClient, runMigrations } from '../../src/infra/storage/sqlite/client.js';
import { SqliteConversationCompactionRepository } from '../../src/infra/storage/sqlite/repositories/conversation-compaction-repository.js';
import { SqliteOperatorChatSessionRepository } from '../../src/infra/storage/sqlite/repositories/operator-chat-session-repository.js';
import { SqliteSessionMemoryRepository } from '../../src/infra/storage/sqlite/repositories/session-memory-repository.js';

function appendTurn(
  repo: SqliteOperatorChatSessionRepository,
  conversationId: string,
  user: string,
  assistant: string,
): void {
  repo.appendMessages(conversationId, [
    {
      role: 'user',
      content: user,
      displayContent: user,
      provider: 'telegram',
    },
    {
      role: 'assistant',
      content: assistant,
      displayContent: assistant,
      provider: 'telegram',
    },
  ]);
}

describe('conversation context service', () => {
  it('extracts session memory from canonical conversation history', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'memphis-conversation-context-'));
    const db = createSqliteClient(`file:${join(dir, 'runtime.db')}`);
    runMigrations(db);

    try {
      const operatorRepo = new SqliteOperatorChatSessionRepository(db);
      const sessionMemoryRepo = new SqliteSessionMemoryRepository(db);
      const compactionRepo = new SqliteConversationCompactionRepository(db);
      const service = new ConversationContextService(operatorRepo, sessionMemoryRepo, compactionRepo);

      appendTurn(
        operatorRepo,
        'primary::telegram:77',
        'I want Memphis to remember preferences across channels.',
        'I will keep the same conversation identity across channels.',
      );
      appendTurn(
        operatorRepo,
        'primary::telegram:77',
        'Please avoid remote defaults and stay local-first.',
        'I will prefer local-first paths and call out remote tradeoffs.',
      );
      appendTurn(
        operatorRepo,
        'primary::telegram:77',
        'We need a release candidate with clear security gates.',
        'I will keep the release gate visible and fail closed.',
      );
      appendTurn(
        operatorRepo,
        'primary::telegram:77',
        'Summarize the migration risk before we ship.',
        'I will preserve the migration risk and rollout constraints.',
      );

      const refresh = await service.refreshConversation({
        conversationId: 'primary::telegram:77',
        actorId: 'telegram:77',
        sourceSurface: 'telegram',
      });
      const overlay = await service.getPromptOverlay('primary::telegram:77');

      expect(refresh.snapshotUpdated).toBe(true);
      expect(refresh.compactionCreated).toBe(false);
      expect(sessionMemoryRepo.getLatest('primary::telegram:77')).toMatchObject({
        actorId: 'telegram:77',
        sourceSurface: 'telegram',
        lastSequence: 8,
      });
      expect(overlay.sessionMemory).toContain('Active goals from this conversation:');
      expect(overlay.sessionMemory).toContain('remember preferences across channels');
      expect(overlay.sessionMemory).toContain('avoid remote defaults and stay local-first');
      expect(overlay.compactions).toEqual([]);
      expect(overlay.trimRecentMessagesTo).toBeUndefined();
    } finally {
      db.close();
    }
  });

  it('creates additive compaction summaries for older conversation ranges', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'memphis-conversation-compaction-'));
    const db = createSqliteClient(`file:${join(dir, 'runtime.db')}`);
    runMigrations(db);

    try {
      const operatorRepo = new SqliteOperatorChatSessionRepository(db);
      const sessionMemoryRepo = new SqliteSessionMemoryRepository(db);
      const compactionRepo = new SqliteConversationCompactionRepository(db);
      const service = new ConversationContextService(operatorRepo, sessionMemoryRepo, compactionRepo);

      for (let i = 1; i <= 14; i += 1) {
        appendTurn(
          operatorRepo,
          'primary::operator:local',
          `Task ${i}: keep Memphis local-first and fail closed during release ${i}.`,
          `Ack ${i}: I will preserve local-first posture and release constraints ${i}.`,
        );
      }

      const refresh = await service.refreshConversation({
        conversationId: 'primary::operator:local',
        actorId: 'operator:local',
        sourceSurface: 'cli.chat',
      });
      const overlay = await service.getPromptOverlay('primary::operator:local');

      expect(refresh.compactionCreated).toBe(true);
      expect(compactionRepo.getLatestEndSequence('primary::operator:local')).toBe(16);
      expect(overlay.trimRecentMessagesTo).toBe(12);
      expect(overlay.compactions).toHaveLength(1);
      expect(overlay.compactions[0]?.summary).toContain('Compacted conversation range 1-16');
      expect(overlay.compactions[0]?.summary).toContain('local-first');
      expect(overlay.sessionMemory).toContain('Active goals from this conversation:');
    } finally {
      db.close();
    }
  });
});
