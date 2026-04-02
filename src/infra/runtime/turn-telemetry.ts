import type { RuntimeTelemetry, TokenUsage } from '../../core/types.js';
import type { ChatMessage } from '../../providers/index.js';
import { resolveModelCapabilitySnapshot } from '../../providers/model-capabilities.js';

export type TurnTelemetrySnapshot = {
  surface: string;
  provider: string;
  model: string;
  recordedAt: string;
  telemetry: RuntimeTelemetry;
};

type BuildRuntimeTelemetryInput = {
  provider: string;
  model: string;
  systemPrompt?: string;
  messages?: ChatMessage[];
  usage?: TokenUsage;
  trimmedMessages?: number;
  compactionCount?: number;
  degraded?: boolean;
  degradationReason?: string;
};

const latestTurnTelemetry = new Map<string, TurnTelemetrySnapshot>();

function serializeMessage(message: ChatMessage): string {
  switch (message.role) {
    case 'system':
    case 'user':
      return message.content;
    case 'assistant':
      return message.tool_calls?.length
        ? `${message.content}\n${JSON.stringify(message.tool_calls)}`
        : message.content;
    case 'tool':
      return `${message.tool_call_id}\n${message.content}`;
  }
}

function estimateTokensFromText(value: string): number {
  if (!value.trim()) return 0;
  return Math.ceil(value.length / 4);
}

export function normalizeTokenUsage(usage?: TokenUsage): TokenUsage | undefined {
  if (!usage) return undefined;

  const inputTokens =
    typeof usage.inputTokens === 'number' && Number.isFinite(usage.inputTokens)
      ? Math.max(0, Math.trunc(usage.inputTokens))
      : undefined;
  const outputTokens =
    typeof usage.outputTokens === 'number' && Number.isFinite(usage.outputTokens)
      ? Math.max(0, Math.trunc(usage.outputTokens))
      : undefined;
  const totalTokens =
    typeof usage.totalTokens === 'number' && Number.isFinite(usage.totalTokens)
      ? Math.max(0, Math.trunc(usage.totalTokens))
      : inputTokens !== undefined || outputTokens !== undefined
        ? (inputTokens ?? 0) + (outputTokens ?? 0)
        : undefined;

  if (inputTokens === undefined && outputTokens === undefined && totalTokens === undefined) {
    return undefined;
  }

  return {
    inputTokens,
    outputTokens,
    totalTokens,
    estimated: usage.estimated === true,
  };
}

export function estimatePromptTokens(input: {
  systemPrompt?: string;
  messages?: ChatMessage[];
}): number {
  const parts: string[] = [];
  if (input.systemPrompt?.trim()) parts.push(input.systemPrompt);
  for (const message of input.messages ?? []) {
    parts.push(serializeMessage(message));
  }
  return estimateTokensFromText(parts.join('\n\n'));
}

export function buildRuntimeTelemetry(input: BuildRuntimeTelemetryInput): RuntimeTelemetry {
  const usage = normalizeTokenUsage(input.usage);
  const estimatedPromptTokens = estimatePromptTokens({
    systemPrompt: input.systemPrompt,
    messages: input.messages,
  });
  const capability = resolveModelCapabilitySnapshot(input.provider, input.model);
  const contextWindowTokens = capability?.contextWindowTokens;
  const remainingContextTokens =
    typeof contextWindowTokens === 'number'
      ? Math.max(0, contextWindowTokens - estimatedPromptTokens)
      : undefined;

  const trimmedMessages = Math.max(0, Math.trunc(input.trimmedMessages ?? 0));
  const compactionCount = Math.max(0, Math.trunc(input.compactionCount ?? 0));
  const recentMessages = Math.max(0, input.messages?.length ?? 0);
  const pressureRatio =
    contextWindowTokens && contextWindowTokens > 0
      ? estimatedPromptTokens / contextWindowTokens
      : 0;

  let compactionLevel: 'low' | 'medium' | 'high' = 'low';
  if (trimmedMessages > 0 || compactionCount > 0 || pressureRatio >= 0.8) {
    compactionLevel =
      pressureRatio >= 0.8 || trimmedMessages >= 8 || compactionCount > 1 ? 'high' : 'medium';
  } else if (pressureRatio >= 0.55) {
    compactionLevel = 'medium';
  }

  return {
    usage,
    contextWindowTokens,
    estimatedPromptTokens,
    remainingContextTokens,
    compactionPressure: {
      level: compactionLevel,
      summaryCount: compactionCount,
      trimmedMessages,
      recentMessages,
    },
    degraded: input.degraded === true,
    degradationReason: input.degradationReason,
  };
}

export function recordTurnTelemetry(input: {
  surface: string;
  provider: string;
  model: string;
  telemetry: RuntimeTelemetry;
  recordedAt?: string;
}): void {
  latestTurnTelemetry.set(input.surface, {
    surface: input.surface,
    provider: input.provider,
    model: input.model,
    recordedAt: input.recordedAt ?? new Date().toISOString(),
    telemetry: input.telemetry,
  });
}

export function snapshotTurnTelemetry(): TurnTelemetrySnapshot[] {
  return Array.from(latestTurnTelemetry.values()).sort((a, b) =>
    a.surface.localeCompare(b.surface),
  );
}

export function resetTurnTelemetryForTests(): void {
  latestTurnTelemetry.clear();
}
