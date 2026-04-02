import { SqliteConversationCompactionRepository } from '../infra/storage/sqlite/repositories/conversation-compaction-repository.js';
import type { OperatorChatMessageRecord } from '../infra/storage/sqlite/repositories/operator-chat-session-repository.js';
import { SqliteOperatorChatSessionRepository } from '../infra/storage/sqlite/repositories/operator-chat-session-repository.js';
import { SqliteSessionMemoryRepository } from '../infra/storage/sqlite/repositories/session-memory-repository.js';

const MIN_MESSAGES_FOR_SESSION_MEMORY = 8;
const MIN_MESSAGES_FOR_COMPACTION = 24;
const KEEP_RECENT_MESSAGES = 12;
const MIN_COMPACTED_MESSAGES = 8;
const MAX_COMPACTION_BLOCKS_IN_PROMPT = 3;
const MAX_SESSION_MEMORY_LINES = 4;
const MAX_ASSISTANT_LINES = 3;
const MAX_FRAGMENT_LENGTH = 240;

export type ConversationPromptOverlay = {
  sessionMemory?: string;
  compactions: Array<{
    summary: string;
    startSequence: number;
    endSequence: number;
  }>;
  trimRecentMessagesTo?: number;
};

export type ConversationRefreshResult = {
  snapshotUpdated: boolean;
  compactionCreated: boolean;
};

function normalizeLine(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

function truncate(value: string, max = MAX_FRAGMENT_LENGTH): string {
  if (value.length <= max) return value;
  return `${value.slice(0, Math.max(1, max - 1)).trimEnd()}…`;
}

function isUsefulLine(value: string): boolean {
  const normalized = normalizeLine(value);
  if (!normalized) return false;
  if (/^\[high-risk user input omitted hash=/i.test(normalized)) return false;
  return true;
}

function uniqueLines(values: string[], limit: number): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const value of values.map(normalizeLine).filter(isUsefulLine)) {
    const key = value.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(truncate(value));
    if (out.length >= limit) break;
  }
  return out;
}

function formatBulletSection(title: string, values: string[]): string {
  if (values.length === 0) return '';
  return `${title}\n${values.map((value) => `- ${value}`).join('\n')}`;
}

function buildSessionMemorySummary(messages: OperatorChatMessageRecord[]): {
  summaryText: string;
  metadata: Record<string, unknown>;
} {
  const userMessages = messages.filter((message) => message.role === 'user');
  const assistantMessages = messages.filter((message) => message.role === 'assistant');
  const goals = uniqueLines(
    [...userMessages].reverse().map((message) => message.content),
    MAX_SESSION_MEMORY_LINES,
  );
  const preferences = uniqueLines(
    [...userMessages]
      .reverse()
      .map((message) => message.content)
      .filter((message) =>
        /(prefer|want|need|must|should|always|never|avoid|without|don't|do not|cannot|can't|required)/i.test(
          message,
        ),
      ),
    MAX_SESSION_MEMORY_LINES,
  );
  const assistantCommitments = uniqueLines(
    [...assistantMessages].reverse().map((message) => message.content),
    MAX_ASSISTANT_LINES,
  );

  const sections = [
    formatBulletSection('Active goals from this conversation:', goals),
    formatBulletSection('Preferences and constraints stated in-session:', preferences),
    formatBulletSection('Latest assistant commitments or outcomes:', assistantCommitments),
  ].filter(Boolean);

  return {
    summaryText: sections.join('\n\n'),
    metadata: {
      goals,
      preferences,
      assistantCommitments,
      sourceMessages: messages.length,
    },
  };
}

function buildCompactionSummary(messages: OperatorChatMessageRecord[], range: {
  startSequence: number;
  endSequence: number;
}): { summaryText: string; metadata: Record<string, unknown> } {
  const userMessages = uniqueLines(
    messages.filter((message) => message.role === 'user').map((message) => message.content),
    6,
  );
  const assistantMessages = uniqueLines(
    messages.filter((message) => message.role === 'assistant').map((message) => message.content),
    4,
  );
  const preferences = uniqueLines(
    messages
      .filter((message) => message.role === 'user')
      .map((message) => message.content)
      .filter((message) =>
        /(prefer|want|need|must|should|always|never|avoid|without|don't|do not|cannot|can't|required)/i.test(
          message,
        ),
      ),
    4,
  );

  const sections = [
    `Compacted conversation range ${range.startSequence}-${range.endSequence}:`,
    formatBulletSection('User requests and topics covered:', userMessages),
    formatBulletSection('Assistant responses and commitments:', assistantMessages),
    formatBulletSection('Constraints and preferences preserved:', preferences),
  ].filter(Boolean);

  return {
    summaryText: sections.join('\n\n'),
    metadata: {
      userMessages,
      assistantMessages,
      preferences,
      coveredMessages: messages.length,
      startSequence: range.startSequence,
      endSequence: range.endSequence,
    },
  };
}

export class ConversationContextService {
  constructor(
    private readonly sessionRepository: SqliteOperatorChatSessionRepository,
    private readonly sessionMemoryRepository: SqliteSessionMemoryRepository,
    private readonly compactionRepository: SqliteConversationCompactionRepository,
  ) {}

  public async getPromptOverlay(
    conversationId: string,
  ): Promise<ConversationPromptOverlay> {
    const snapshot = this.sessionMemoryRepository.getLatest(conversationId);
    const compactions = this.compactionRepository.listRecent(
      conversationId,
      MAX_COMPACTION_BLOCKS_IN_PROMPT,
    );

    return {
      sessionMemory: snapshot?.summaryText || undefined,
      compactions: compactions.map((item) => ({
        summary: item.summaryText,
        startSequence: item.startSequence,
        endSequence: item.endSequence,
      })),
      trimRecentMessagesTo: compactions.length > 0 ? KEEP_RECENT_MESSAGES : undefined,
    };
  }

  public async refreshConversation(input: {
    conversationId: string;
    actorId?: string;
    sourceSurface?: string;
  }): Promise<ConversationRefreshResult> {
    const latestSequence = this.sessionRepository.getMaxSequence(input.conversationId);
    if (latestSequence <= 0) {
      return { snapshotUpdated: false, compactionCreated: false };
    }

    const snapshotUpdated = this.refreshSessionMemory(input, latestSequence);
    const compactionCreated = this.refreshCompaction(input.conversationId, latestSequence);
    return { snapshotUpdated, compactionCreated };
  }

  private refreshSessionMemory(
    input: { conversationId: string; actorId?: string; sourceSurface?: string },
    latestSequence: number,
  ): boolean {
    const existing = this.sessionMemoryRepository.getLatest(input.conversationId);
    if (existing && existing.lastSequence >= latestSequence) {
      return false;
    }

    const totalMessages = this.sessionRepository.countMessages(input.conversationId);
    if (totalMessages < MIN_MESSAGES_FOR_SESSION_MEMORY) {
      return false;
    }

    const messages = this.sessionRepository.listMessages(input.conversationId, 16);
    const turnCount = messages.filter((message) => message.role === 'user').length;
    const summary = buildSessionMemorySummary(messages);
    if (!summary.summaryText.trim()) {
      return false;
    }

    this.sessionMemoryRepository.save({
      conversationId: input.conversationId,
      actorId: input.actorId,
      sourceSurface: input.sourceSurface,
      turnCount,
      lastSequence: latestSequence,
      summaryText: summary.summaryText,
      metadata: summary.metadata,
    });
    return true;
  }

  private refreshCompaction(conversationId: string, latestSequence: number): boolean {
    const totalMessages = this.sessionRepository.countMessages(conversationId);
    if (totalMessages < MIN_MESSAGES_FOR_COMPACTION) {
      return false;
    }

    const latestCompactedEnd = this.compactionRepository.getLatestEndSequence(conversationId);
    const targetEndSequence = latestSequence - KEEP_RECENT_MESSAGES;
    if (targetEndSequence <= latestCompactedEnd) {
      return false;
    }

    const startSequence = Math.max(1, latestCompactedEnd + 1);
    const messages = this.sessionRepository.listMessagesRange(
      conversationId,
      startSequence,
      targetEndSequence,
    );
    if (messages.length < MIN_COMPACTED_MESSAGES) {
      return false;
    }

    const summary = buildCompactionSummary(messages, {
      startSequence,
      endSequence: targetEndSequence,
    });
    if (!summary.summaryText.trim()) {
      return false;
    }

    this.compactionRepository.save({
      conversationId,
      startSequence,
      endSequence: targetEndSequence,
      summaryText: summary.summaryText,
      metadata: summary.metadata,
    });
    return true;
  }
}
