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
      const service = new ConversationContextService(
        operatorRepo,
        sessionMemoryRepo,
        compactionRepo,
      );

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
      const snapshot = sessionMemoryRepo.getLatest('primary::telegram:77');

      expect(refresh.snapshotUpdated).toBe(true);
      expect(refresh.compactionCreated).toBe(false);
      expect(snapshot).toMatchObject({
        actorId: 'telegram:77',
        sourceSurface: 'telegram',
        lastSequence: 8,
      });
      expect(snapshot?.metadata).toMatchObject({
        goals: expect.arrayContaining(['Summarize the migration risk before we ship']),
        preferences: expect.arrayContaining(['Please avoid remote defaults and stay local-first']),
        openLoops: expect.arrayContaining([
          'I will preserve the migration risk and rollout constraints',
        ]),
      });
      expect(overlay.sessionMemory).toContain('Current goals and asks:');
      expect(overlay.sessionMemory).toContain('remember preferences across channels');
      expect(overlay.sessionMemory).toContain('avoid remote defaults and stay local-first');
      expect(overlay.sessionMemory).toContain('Open loops to carry forward:');
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
      const service = new ConversationContextService(
        operatorRepo,
        sessionMemoryRepo,
        compactionRepo,
      );

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
      const latestCompaction = compactionRepo.listRecent('primary::operator:local', 1)[0];

      expect(refresh.compactionCreated).toBe(true);
      expect(compactionRepo.getLatestEndSequence('primary::operator:local')).toBe(16);
      expect(overlay.trimRecentMessagesTo).toBe(12);
      expect(overlay.compactions).toHaveLength(1);
      expect(overlay.compactions[0]?.summary).toContain('Compacted conversation range 1-16');
      expect(overlay.compactions[0]?.summary).toContain('Goals and asks carried forward:');
      expect(overlay.compactions[0]?.summary).toContain('Open loops still relevant:');
      expect(overlay.compactions[0]?.summary).toContain('local-first');
      expect(latestCompaction?.metadata).toMatchObject({
        goals: expect.arrayContaining([
          'Task 8: keep Memphis local-first and fail closed during release 8',
        ]),
        preferences: expect.arrayContaining([
          'Task 8: keep Memphis local-first and fail closed during release 8',
        ]),
      });
      expect(overlay.sessionMemory).toContain('Current goals and asks:');
    } finally {
      db.close();
    }
  });

  it('separates completed outcomes from open loops in session snapshots', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'memphis-conversation-status-'));
    const db = createSqliteClient(`file:${join(dir, 'runtime.db')}`);
    runMigrations(db);

    try {
      const operatorRepo = new SqliteOperatorChatSessionRepository(db);
      const sessionMemoryRepo = new SqliteSessionMemoryRepository(db);
      const compactionRepo = new SqliteConversationCompactionRepository(db);
      const service = new ConversationContextService(
        operatorRepo,
        sessionMemoryRepo,
        compactionRepo,
      );

      appendTurn(
        operatorRepo,
        'primary::operator:local',
        'Cut v1.2.1 and publish the release artifacts.',
        'I will cut v1.2.1 and publish the release artifacts.',
      );
      appendTurn(
        operatorRepo,
        'primary::operator:local',
        'Keep the runtime local-first and fail closed.',
        'I will keep the runtime local-first and fail closed.',
      );
      appendTurn(
        operatorRepo,
        'primary::operator:local',
        'Confirm whether CI already passed.',
        'CI is green and the v1.2.1 release tag is published.',
      );
      appendTurn(
        operatorRepo,
        'primary::operator:local',
        'We still need to verify package visibility.',
        'I still need to verify package visibility in the registry.',
      );

      await service.refreshConversation({
        conversationId: 'primary::operator:local',
        actorId: 'operator:local',
        sourceSurface: 'cli.chat',
      });

      const snapshot = sessionMemoryRepo.getLatest('primary::operator:local');
      expect(snapshot?.metadata).toMatchObject({
        completedOutcomes: expect.arrayContaining([
          'CI is green and the v1.2.1 release tag is published',
        ]),
        openLoops: expect.arrayContaining([
          'I still need to verify package visibility in the registry',
          'I will keep the runtime local-first and fail closed',
        ]),
      });
      expect(snapshot?.summaryText).toContain('Recent confirmed outcomes:');
      expect(snapshot?.summaryText).toContain('Open loops to carry forward:');
    } finally {
      db.close();
    }
  });

  it('creates session memory earlier when telemetry reports context pressure', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'memphis-conversation-pressure-session-'));
    const db = createSqliteClient(`file:${join(dir, 'runtime.db')}`);
    runMigrations(db);

    try {
      const operatorRepo = new SqliteOperatorChatSessionRepository(db);
      const sessionMemoryRepo = new SqliteSessionMemoryRepository(db);
      const compactionRepo = new SqliteConversationCompactionRepository(db);
      const service = new ConversationContextService(
        operatorRepo,
        sessionMemoryRepo,
        compactionRepo,
      );

      appendTurn(
        operatorRepo,
        'primary::operator:pressure',
        'Keep Memphis local-first while the context window gets tight.',
        'I will preserve local-first behavior and keep the budget visible.',
      );
      appendTurn(
        operatorRepo,
        'primary::operator:pressure',
        'Remember release constraints and avoid remote defaults.',
        'I will carry forward release constraints and avoid remote defaults.',
      );
      appendTurn(
        operatorRepo,
        'primary::operator:pressure',
        'We still need to verify the rollout checklist.',
        'I still need to verify the rollout checklist before release.',
      );

      const refresh = await service.refreshConversation({
        conversationId: 'primary::operator:pressure',
        actorId: 'operator:local',
        sourceSurface: 'cli.chat',
        telemetry: {
          contextWindowTokens: 8192,
          estimatedPromptTokens: 6600,
          remainingContextTokens: 1592,
          compactionPressure: {
            level: 'high',
            summaryCount: 0,
            trimmedMessages: 0,
            recentMessages: 6,
          },
        },
      });

      const snapshot = sessionMemoryRepo.getLatest('primary::operator:pressure');
      expect(refresh.snapshotUpdated).toBe(true);
      expect(refresh.compactionCreated).toBe(false);
      expect(snapshot?.metadata).toMatchObject({
        refreshPolicy: {
          mode: 'telemetry-high',
          reason: 'compaction_pressure_high',
          minimumMessages: 6,
          observedMessages: 6,
        },
        telemetry: {
          remainingContextTokens: 1592,
          compactionPressureLevel: 'high',
        },
      });
    } finally {
      db.close();
    }
  });

  it('compacts earlier and reduces recent message carry-forward when telemetry pressure is high', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'memphis-conversation-pressure-compaction-'));
    const db = createSqliteClient(`file:${join(dir, 'runtime.db')}`);
    runMigrations(db);

    try {
      const operatorRepo = new SqliteOperatorChatSessionRepository(db);
      const sessionMemoryRepo = new SqliteSessionMemoryRepository(db);
      const compactionRepo = new SqliteConversationCompactionRepository(db);
      const service = new ConversationContextService(
        operatorRepo,
        sessionMemoryRepo,
        compactionRepo,
      );

      for (let i = 1; i <= 9; i += 1) {
        appendTurn(
          operatorRepo,
          'primary::operator:compaction-pressure',
          `Task ${i}: keep Memphis local-first and preserve the release checklist ${i}.`,
          `Ack ${i}: I will keep Memphis local-first and preserve the release checklist ${i}.`,
        );
      }

      const refresh = await service.refreshConversation({
        conversationId: 'primary::operator:compaction-pressure',
        actorId: 'operator:local',
        sourceSurface: 'cli.chat',
        telemetry: {
          contextWindowTokens: 8192,
          estimatedPromptTokens: 7000,
          remainingContextTokens: 1192,
          compactionPressure: {
            level: 'high',
            summaryCount: 0,
            trimmedMessages: 0,
            recentMessages: 18,
          },
        },
      });

      const overlay = await service.getPromptOverlay('primary::operator:compaction-pressure');
      const latestCompaction = compactionRepo.listRecent(
        'primary::operator:compaction-pressure',
        1,
      )[0];

      expect(refresh.compactionCreated).toBe(true);
      expect(compactionRepo.getLatestEndSequence('primary::operator:compaction-pressure')).toBe(10);
      expect(overlay.trimRecentMessagesTo).toBe(8);
      expect(latestCompaction?.metadata).toMatchObject({
        refreshPolicy: {
          mode: 'telemetry-high',
          reason: 'compaction_pressure_high',
          minimumMessages: 16,
          observedMessages: 18,
        },
        telemetry: {
          remainingContextTokens: 1192,
          compactionPressureLevel: 'high',
        },
        recommendedRecentMessages: 8,
      });
      expect(overlay.compactions[0]?.summary).toContain('Compacted conversation range 1-10');
    } finally {
      db.close();
    }
  });
});
