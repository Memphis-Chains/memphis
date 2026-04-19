import type { RuntimeTelemetry } from '../core/types.js';
import { SqliteConversationCompactionRepository } from '../infra/storage/sqlite/repositories/conversation-compaction-repository.js';
import type { OperatorChatMessageRecord } from '../infra/storage/sqlite/repositories/operator-chat-session-repository.js';
import { SqliteOperatorChatSessionRepository } from '../infra/storage/sqlite/repositories/operator-chat-session-repository.js';
import { SqliteSessionMemoryRepository } from '../infra/storage/sqlite/repositories/session-memory-repository.js';

const MIN_MESSAGES_FOR_SESSION_MEMORY = 8;
const MIN_MESSAGES_FOR_SESSION_MEMORY_UNDER_PRESSURE = 6;
const MIN_MESSAGES_FOR_COMPACTION = 24;
const MIN_MESSAGES_FOR_COMPACTION_MEDIUM_PRESSURE = 18;
const MIN_MESSAGES_FOR_COMPACTION_HIGH_PRESSURE = 16;
const KEEP_RECENT_MESSAGES = 12;
const KEEP_RECENT_MESSAGES_MEDIUM_PRESSURE = 10;
const KEEP_RECENT_MESSAGES_HIGH_PRESSURE = 8;
const MIN_COMPACTED_MESSAGES = 8;
const MIN_COMPACTED_MESSAGES_HIGH_PRESSURE = 6;
const MAX_COMPACTION_BLOCKS_IN_PROMPT = 3;
const MAX_SESSION_GOAL_LINES = 4;
const MAX_SESSION_PREFERENCE_LINES = 3;
const MAX_SESSION_OPEN_LOOP_LINES = 3;
const MAX_SESSION_OUTCOME_LINES = 3;
const MAX_SESSION_TOOL_RESULT_LINES = 2;
const MAX_COMPACTION_GOAL_LINES = 5;
const MAX_COMPACTION_PREFERENCE_LINES = 4;
const MAX_COMPACTION_OPEN_LOOP_LINES = 4;
const MAX_COMPACTION_OUTCOME_LINES = 4;
const MAX_COMPACTION_TOOL_RESULT_LINES = 3;
const MAX_FALLBACK_HIGHLIGHT_LINES = 3;
const MAX_FRAGMENT_LENGTH = 240;
const MIN_FRAGMENT_LENGTH = 8;
const REMAINING_CONTEXT_TOKENS_MEDIUM = 4096;
const REMAINING_CONTEXT_TOKENS_HIGH = 2048;

// Fragments matching these patterns are excluded from session_memory and compactions
// to prevent system-prompt echo loops (e.g. "Fallback response: SYSTEM: <soul_manifest>")
const BLOCKED_FRAGMENT_PATTERNS = [
  /<soul_manifest>/i,
  /<\/soul_manifest>/i,
  /Fallback response: SYSTEM:/i,
  /Fallback response: \{/i,
  /\[filtered: protected system prompt\]/i,
  /<session_memory>/i,
  /<\/session_memory>/i,
  /<conversation_compaction/i,
  /<\/conversation_compaction>/i,
  /<soul_boot>/i,
  /<\/soul_boot>/i,
];

function isFragmentBlocked(value: string): boolean {
  return BLOCKED_FRAGMENT_PATTERNS.some((pat) => pat.test(value));
}

const PREFERENCE_PATTERN =
  /\b(prefer|preference|avoid|without|local-first|local first|fail closed|fail-closed|never|always|required|must|should|do not|don't|cannot|can't|full control|override|tiered|constraint)\b/i;
const GOAL_HINT_PATTERN =
  /\b(need|want|please|remember|support|keep|build|implement|fix|summarize|review|plan|ship|release|migrate|preserve|add|continue|start|cut|publish|verify|monitor|install|run|align)\b/i;
const OPEN_LOOP_PATTERN =
  /\b(i will|i'll|we will|we'll|i can|we can|next\b|follow up|remaining|left to do|left to|still need|need to|needs to|going to|pending|todo|to do|working on)\b/i;
const USER_PENDING_PATTERN =
  /\b(still need|remaining|left to do|left to|pending|todo|to do|follow up|verify|monitor)\b/i;
const COMPLETED_PATTERN =
  /\b(done|completed|implemented|fixed|published|released|created|updated|verified|confirmed|green|passed|installed|aligned|synced|finished|available|cut|shipped)\b/i;
const TOOL_RESULT_PATTERN =
  /\b(ci|test|tests|health|status|release|tag|package|publish|artifact|worker|scheduler|memory|compaction|recall|search|runtime|doctor)\b/i;

const KEYWORD_STOPWORDS = new Set([
  'a',
  'an',
  'and',
  'are',
  'as',
  'at',
  'be',
  'by',
  'for',
  'from',
  'i',
  'if',
  'in',
  'into',
  'is',
  'it',
  'keep',
  'local',
  'need',
  'of',
  'on',
  'or',
  'please',
  'so',
  'that',
  'the',
  'this',
  'to',
  'up',
  'we',
  'will',
  'with',
]);

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

type CompactionPressureLevel = NonNullable<RuntimeTelemetry['compactionPressure']>['level'];

type ContextRefreshPolicy = {
  mode: 'baseline' | 'telemetry-medium' | 'telemetry-high';
  reason: string;
  sessionMemoryMinMessages: number;
  compactionMinMessages: number;
  keepRecentMessages: number;
  minCompactedMessages: number;
  telemetrySnapshot: {
    contextWindowTokens?: number;
    estimatedPromptTokens?: number;
    remainingContextTokens?: number;
    compactionPressureLevel?: CompactionPressureLevel;
    degraded?: boolean;
    degradationReason?: string;
  };
};

function normalizeLine(value: string): string {
  return value
    .replace(/<\/?[^>]+>/g, ' ')
    .replace(/`+/g, '')
    .replace(/^[\s>*#-]+/g, ' ')
    .replace(/^(user|assistant|tool):\s*/i, '')
    .replace(/\s+/g, ' ')
    .replace(/\s+([,.;!?])/g, '$1')
    .trim();
}

function truncate(value: string, max = MAX_FRAGMENT_LENGTH): string {
  if (value.length <= max) return value;
  return `${value.slice(0, Math.max(1, max - 1)).trimEnd()}…`;
}

function isUsefulLine(value: string): boolean {
  const normalized = normalizeLine(value);
  if (!normalized) return false;
  if (/^\[high-risk user input omitted hash=/i.test(normalized)) return false;
  if (!/[a-z0-9]/i.test(normalized)) return false;
  if (normalized.length < MIN_FRAGMENT_LENGTH) return false;
  return true;
}

function dedupeKey(value: string): string {
  return normalizeLine(value)
    .replace(/[^a-z0-9]+/gi, ' ')
    .trim()
    .toLowerCase();
}

function uniqueLines(values: string[], limit: number): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const value of values
    .map(normalizeLine)
    .filter(isUsefulLine)
    .filter((v) => !isFragmentBlocked(v))) {
    const key = dedupeKey(value);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(truncate(value));
    if (out.length >= limit) break;
  }
  return out;
}

function asPositiveInteger(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value)) return undefined;
  const normalized = Math.trunc(value);
  return normalized > 0 ? normalized : undefined;
}

function formatBulletSection(title: string, values: string[]): string {
  if (values.length === 0) return '';
  return `${title}\n${values.map((value) => `- ${value}`).join('\n')}`;
}

function splitMessageFragments(message: OperatorChatMessageRecord): string[] {
  const raw = `${message.displayContent || message.content || ''}`
    .replace(/\r\n/g, '\n')
    .replace(/[•·]/g, '\n');
  return raw
    .split(/\n+|(?<=[.!?;])\s+/u)
    .map((fragment) =>
      normalizeLine(fragment)
        .replace(/[.?!;:]+$/g, '')
        .trim(),
    )
    .filter(isUsefulLine);
}

function extractKeywords(value: string): string[] {
  const matches = value.toLowerCase().match(/[a-z0-9][a-z0-9.-]+/g) ?? [];
  return matches.filter((token) => token.length >= 4 && !KEYWORD_STOPWORDS.has(token));
}

function sharesMeaningfulKeywords(left: string, right: string): boolean {
  const leftKeywords = new Set(extractKeywords(left));
  if (leftKeywords.size === 0) return false;
  let shared = 0;
  for (const token of extractKeywords(right)) {
    if (!leftKeywords.has(token)) continue;
    shared += 1;
    if (shared >= 2) return true;
  }
  return false;
}

function collectFragments(
  messages: OperatorChatMessageRecord[],
  options: {
    roles: OperatorChatMessageRecord['role'][];
    limit: number;
    reverse?: boolean;
    predicate?: (fragment: string, message: OperatorChatMessageRecord) => boolean;
  },
): string[] {
  const ordered = options.reverse === false ? messages : [...messages].reverse();
  const fragments: string[] = [];

  for (const message of ordered) {
    if (!options.roles.includes(message.role)) continue;
    for (const fragment of splitMessageFragments(message)) {
      if (options.predicate && !options.predicate(fragment, message)) continue;
      fragments.push(fragment);
    }
  }

  return uniqueLines(fragments, options.limit);
}

type ConversationInsights = {
  goals: string[];
  preferences: string[];
  openLoops: string[];
  completedOutcomes: string[];
  toolResults: string[];
  fallbackHighlights: string[];
};

function buildConversationInsights(
  messages: OperatorChatMessageRecord[],
  limits: {
    goals: number;
    preferences: number;
    openLoops: number;
    outcomes: number;
    toolResults: number;
  },
): ConversationInsights {
  const completedOutcomes = collectFragments(messages, {
    roles: ['assistant', 'tool'],
    limit: limits.outcomes,
    predicate: (fragment, message) =>
      message.role === 'tool' ||
      (COMPLETED_PATTERN.test(fragment) && !OPEN_LOOP_PATTERN.test(fragment)),
  });

  const preferences = collectFragments(messages, {
    roles: ['user', 'assistant'],
    limit: limits.preferences,
    predicate: (fragment, message) =>
      PREFERENCE_PATTERN.test(fragment) &&
      (message.role === 'user' || !COMPLETED_PATTERN.test(fragment)),
  });

  const openLoops = collectFragments(messages, {
    roles: ['assistant', 'user'],
    limit: limits.openLoops,
    predicate: (fragment, message) => {
      const pending =
        message.role === 'assistant'
          ? OPEN_LOOP_PATTERN.test(fragment) && !COMPLETED_PATTERN.test(fragment)
          : USER_PENDING_PATTERN.test(fragment);
      if (!pending) return false;
      return !completedOutcomes.some((outcome) => sharesMeaningfulKeywords(fragment, outcome));
    },
  });

  let goals = collectFragments(messages, {
    roles: ['user'],
    limit: limits.goals,
    predicate: (fragment) =>
      !PREFERENCE_PATTERN.test(fragment) &&
      !USER_PENDING_PATTERN.test(fragment) &&
      (GOAL_HINT_PATTERN.test(fragment) || fragment.endsWith('?')),
  });
  if (goals.length === 0) {
    goals = collectFragments(messages, {
      roles: ['user'],
      limit: limits.goals,
      predicate: (fragment) => !PREFERENCE_PATTERN.test(fragment),
    });
  }
  if (goals.length === 0) {
    goals = collectFragments(messages, {
      roles: ['user'],
      limit: limits.goals,
    });
  }

  const toolResults = collectFragments(messages, {
    roles: ['tool', 'assistant'],
    limit: limits.toolResults,
    predicate: (fragment, message) =>
      message.role === 'tool' ||
      (TOOL_RESULT_PATTERN.test(fragment) && COMPLETED_PATTERN.test(fragment)),
  });

  const fallbackHighlights = collectFragments(messages, {
    roles: ['user', 'assistant'],
    limit: MAX_FALLBACK_HIGHLIGHT_LINES,
  });

  return {
    goals,
    preferences,
    openLoops,
    completedOutcomes,
    toolResults,
    fallbackHighlights,
  };
}

function buildSessionMemorySummary(messages: OperatorChatMessageRecord[]): {
  summaryText: string;
  metadata: Record<string, unknown>;
} {
  const insights = buildConversationInsights(messages, {
    goals: MAX_SESSION_GOAL_LINES,
    preferences: MAX_SESSION_PREFERENCE_LINES,
    openLoops: MAX_SESSION_OPEN_LOOP_LINES,
    outcomes: MAX_SESSION_OUTCOME_LINES,
    toolResults: MAX_SESSION_TOOL_RESULT_LINES,
  });

  const sections = [
    formatBulletSection('Current goals and asks:', insights.goals),
    formatBulletSection('Preferences and constraints:', insights.preferences),
    formatBulletSection('Open loops to carry forward:', insights.openLoops),
    formatBulletSection('Recent confirmed outcomes:', insights.completedOutcomes),
    formatBulletSection('Tool and system results worth remembering:', insights.toolResults),
  ].filter(Boolean);

  if (sections.length === 0 && insights.fallbackHighlights.length > 0) {
    sections.push(
      formatBulletSection('Recent conversation highlights:', insights.fallbackHighlights),
    );
  }

  return {
    summaryText: sections.join('\n\n'),
    metadata: {
      goals: insights.goals,
      preferences: insights.preferences,
      openLoops: insights.openLoops,
      completedOutcomes: insights.completedOutcomes,
      toolResults: insights.toolResults,
      fallbackHighlights: insights.fallbackHighlights,
      sourceMessages: messages.length,
    },
  };
}

function buildCompactionSummary(
  messages: OperatorChatMessageRecord[],
  range: {
    startSequence: number;
    endSequence: number;
  },
): { summaryText: string; metadata: Record<string, unknown> } {
  const insights = buildConversationInsights(messages, {
    goals: MAX_COMPACTION_GOAL_LINES,
    preferences: MAX_COMPACTION_PREFERENCE_LINES,
    openLoops: MAX_COMPACTION_OPEN_LOOP_LINES,
    outcomes: MAX_COMPACTION_OUTCOME_LINES,
    toolResults: MAX_COMPACTION_TOOL_RESULT_LINES,
  });

  const sections = [
    `Compacted conversation range ${range.startSequence}-${range.endSequence}:`,
    formatBulletSection('Goals and asks carried forward:', insights.goals),
    formatBulletSection('Constraints and preferences preserved:', insights.preferences),
    formatBulletSection('Open loops still relevant:', insights.openLoops),
    formatBulletSection('Confirmed outcomes and decisions:', insights.completedOutcomes),
    formatBulletSection('Tool and system results captured:', insights.toolResults),
  ].filter(Boolean);

  return {
    summaryText: sections.join('\n\n'),
    metadata: {
      goals: insights.goals,
      preferences: insights.preferences,
      openLoops: insights.openLoops,
      completedOutcomes: insights.completedOutcomes,
      toolResults: insights.toolResults,
      fallbackHighlights: insights.fallbackHighlights,
      coveredMessages: messages.length,
      startSequence: range.startSequence,
      endSequence: range.endSequence,
    },
  };
}

function resolveContextRefreshPolicy(telemetry?: RuntimeTelemetry): ContextRefreshPolicy {
  const remainingContextTokens = telemetry?.remainingContextTokens;
  const pressureLevel = telemetry?.compactionPressure?.level;
  const highPressure =
    pressureLevel === 'high' ||
    (typeof remainingContextTokens === 'number' &&
      remainingContextTokens <= REMAINING_CONTEXT_TOKENS_HIGH);
  const mediumPressure =
    !highPressure &&
    (pressureLevel === 'medium' ||
      (typeof remainingContextTokens === 'number' &&
        remainingContextTokens <= REMAINING_CONTEXT_TOKENS_MEDIUM));

  if (highPressure) {
    return {
      mode: 'telemetry-high',
      reason:
        pressureLevel === 'high' ? 'compaction_pressure_high' : 'remaining_context_tokens_low',
      sessionMemoryMinMessages: MIN_MESSAGES_FOR_SESSION_MEMORY_UNDER_PRESSURE,
      compactionMinMessages: MIN_MESSAGES_FOR_COMPACTION_HIGH_PRESSURE,
      keepRecentMessages: KEEP_RECENT_MESSAGES_HIGH_PRESSURE,
      minCompactedMessages: MIN_COMPACTED_MESSAGES_HIGH_PRESSURE,
      telemetrySnapshot: {
        contextWindowTokens: telemetry?.contextWindowTokens,
        estimatedPromptTokens: telemetry?.estimatedPromptTokens,
        remainingContextTokens,
        compactionPressureLevel: pressureLevel,
        degraded: telemetry?.degraded,
        degradationReason: telemetry?.degradationReason,
      },
    };
  }

  if (mediumPressure) {
    return {
      mode: 'telemetry-medium',
      reason:
        pressureLevel === 'medium'
          ? 'compaction_pressure_medium'
          : 'remaining_context_tokens_reduced',
      sessionMemoryMinMessages: MIN_MESSAGES_FOR_SESSION_MEMORY_UNDER_PRESSURE,
      compactionMinMessages: MIN_MESSAGES_FOR_COMPACTION_MEDIUM_PRESSURE,
      keepRecentMessages: KEEP_RECENT_MESSAGES_MEDIUM_PRESSURE,
      minCompactedMessages: MIN_COMPACTED_MESSAGES,
      telemetrySnapshot: {
        contextWindowTokens: telemetry?.contextWindowTokens,
        estimatedPromptTokens: telemetry?.estimatedPromptTokens,
        remainingContextTokens,
        compactionPressureLevel: pressureLevel,
        degraded: telemetry?.degraded,
        degradationReason: telemetry?.degradationReason,
      },
    };
  }

  return {
    mode: 'baseline',
    reason: 'message_count_threshold',
    sessionMemoryMinMessages: MIN_MESSAGES_FOR_SESSION_MEMORY,
    compactionMinMessages: MIN_MESSAGES_FOR_COMPACTION,
    keepRecentMessages: KEEP_RECENT_MESSAGES,
    minCompactedMessages: MIN_COMPACTED_MESSAGES,
    telemetrySnapshot: {
      contextWindowTokens: telemetry?.contextWindowTokens,
      estimatedPromptTokens: telemetry?.estimatedPromptTokens,
      remainingContextTokens,
      compactionPressureLevel: pressureLevel,
      degraded: telemetry?.degraded,
      degradationReason: telemetry?.degradationReason,
    },
  };
}

export class ConversationContextService {
  constructor(
    private readonly sessionRepository: SqliteOperatorChatSessionRepository,
    private readonly sessionMemoryRepository: SqliteSessionMemoryRepository,
    private readonly compactionRepository: SqliteConversationCompactionRepository,
  ) {}

  public async getPromptOverlay(conversationId: string): Promise<ConversationPromptOverlay> {
    const snapshot = this.sessionMemoryRepository.getLatest(conversationId);
    const compactions = this.compactionRepository.listRecent(
      conversationId,
      MAX_COMPACTION_BLOCKS_IN_PROMPT,
    );
    const latestCompaction = compactions.at(-1);
    const trimRecentMessagesTo =
      compactions.length > 0
        ? (asPositiveInteger(latestCompaction?.metadata?.recommendedRecentMessages) ??
          KEEP_RECENT_MESSAGES)
        : undefined;

    return {
      sessionMemory: snapshot?.summaryText || undefined,
      compactions: compactions.map((item) => ({
        summary: item.summaryText,
        startSequence: item.startSequence,
        endSequence: item.endSequence,
      })),
      trimRecentMessagesTo,
    };
  }

  public async refreshConversation(input: {
    conversationId: string;
    actorId?: string;
    sourceSurface?: string;
    telemetry?: RuntimeTelemetry;
  }): Promise<ConversationRefreshResult> {
    const latestSequence = this.sessionRepository.getMaxSequence(input.conversationId);
    if (latestSequence <= 0) {
      return { snapshotUpdated: false, compactionCreated: false };
    }

    const policy = resolveContextRefreshPolicy(input.telemetry);
    const snapshotUpdated = this.refreshSessionMemory(input, latestSequence, policy);
    const compactionCreated = this.refreshCompaction(input.conversationId, latestSequence, policy);
    return { snapshotUpdated, compactionCreated };
  }

  private refreshSessionMemory(
    input: {
      conversationId: string;
      actorId?: string;
      sourceSurface?: string;
      telemetry?: RuntimeTelemetry;
    },
    latestSequence: number,
    policy: ContextRefreshPolicy,
  ): boolean {
    const existing = this.sessionMemoryRepository.getLatest(input.conversationId);
    if (existing && existing.lastSequence >= latestSequence) {
      return false;
    }

    const totalMessages = this.sessionRepository.countMessages(input.conversationId);
    if (totalMessages < policy.sessionMemoryMinMessages) {
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
      metadata: {
        ...summary.metadata,
        refreshPolicy: {
          mode: policy.mode,
          reason: policy.reason,
          minimumMessages: policy.sessionMemoryMinMessages,
          observedMessages: totalMessages,
        },
        telemetry: policy.telemetrySnapshot,
      },
    });
    return true;
  }

  private refreshCompaction(
    conversationId: string,
    latestSequence: number,
    policy: ContextRefreshPolicy,
  ): boolean {
    const totalMessages = this.sessionRepository.countMessages(conversationId);
    if (totalMessages < policy.compactionMinMessages) {
      return false;
    }

    const latestCompactedEnd = this.compactionRepository.getLatestEndSequence(conversationId);
    const targetEndSequence = latestSequence - policy.keepRecentMessages;
    if (targetEndSequence <= latestCompactedEnd) {
      return false;
    }

    const startSequence = Math.max(1, latestCompactedEnd + 1);
    const messages = this.sessionRepository.listMessagesRange(
      conversationId,
      startSequence,
      targetEndSequence,
    );
    if (messages.length < policy.minCompactedMessages) {
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
      metadata: {
        ...summary.metadata,
        refreshPolicy: {
          mode: policy.mode,
          reason: policy.reason,
          minimumMessages: policy.compactionMinMessages,
          observedMessages: totalMessages,
        },
        telemetry: policy.telemetrySnapshot,
        recommendedRecentMessages: policy.keepRecentMessages,
      },
    });
    return true;
  }
}
