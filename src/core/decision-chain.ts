import type { DecisionRecord } from './decision-lifecycle.js';
import { createDecision } from './decision-lifecycle.js';
import type { Block } from '../memory/chain.js';

type DecisionChainData = Record<string, unknown> & {
  title?: string;
  choice?: string;
  chosen?: string;
  context?: string;
  content?: string;
  tags?: string[];
  id?: string;
  confidence?: number;
  status?: string;
  refs?: string[];
  options?: string[];
  createdAt?: string;
  updatedAt?: string;
  schemaVersion?: number;
  correlationId?: string;
};

const DECISION_META_PREFIX = '[decision_meta] ';

function normalizeTags(value: unknown, fallback: string[] = ['decision']): string[] {
  const tags = Array.isArray(value)
    ? value.filter((tag): tag is string => typeof tag === 'string' && tag.trim().length > 0)
    : [];
  return Array.from(new Set(tags.length > 0 ? tags : fallback));
}

function normalizeOptions(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return Array.from(
    new Set(
      value.filter((item): item is string => typeof item === 'string' && item.trim().length > 0),
    ),
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseDecisionContentEnvelope(content: unknown): {
  summary?: string;
  metadata?: Record<string, unknown>;
} {
  if (typeof content !== 'string' || content.trim().length === 0) {
    return {};
  }

  const trimmed = content.trim();
  if (trimmed.startsWith('{')) {
    try {
      const parsed = JSON.parse(trimmed) as unknown;
      if (isRecord(parsed)) {
        return { metadata: parsed };
      }
    } catch {
      // not structured metadata
    }
  }

  const prefixedAtStart = content.startsWith(DECISION_META_PREFIX);
  const markerIndex = prefixedAtStart ? 0 : content.lastIndexOf(`\n\n${DECISION_META_PREFIX}`);
  if (markerIndex < 0) {
    return {};
  }

  const prefixIndex = prefixedAtStart ? 0 : markerIndex + 2;
  const rawMetadata = content.slice(prefixIndex + DECISION_META_PREFIX.length).trim();

  try {
    const parsed = JSON.parse(rawMetadata) as unknown;
    if (!isRecord(parsed)) {
      return {};
    }

    const summary = prefixIndex > 0 ? content.slice(0, markerIndex).trim() : '';
    return {
      summary: summary || undefined,
      metadata: parsed,
    };
  } catch {
    return {};
  }
}

export function buildDecisionContent(input: {
  title?: unknown;
  choice?: unknown;
  context?: unknown;
  content?: unknown;
}): string | null {
  if (typeof input.content === 'string' && input.content.trim().length > 0) {
    return input.content.trim();
  }

  const title = typeof input.title === 'string' ? input.title.trim() : '';
  const choice = typeof input.choice === 'string' ? input.choice.trim() : '';
  const context = typeof input.context === 'string' ? input.context.trim() : '';

  if (!title && !choice && !context) {
    return null;
  }

  return [
    title ? `Decision: ${title}` : '',
    choice ? `Choice: ${choice}` : '',
    context ? `Context: ${context}` : '',
  ]
    .filter(Boolean)
    .join('\n');
}

export function normalizeDecisionBlockData(
  data: Record<string, unknown>,
  options: {
    source?: string;
    fallbackTags?: string[];
  } = {},
): DecisionChainData {
  const envelope = parseDecisionContentEnvelope(data.content);
  const normalized: DecisionChainData = {
    ...(envelope.metadata ?? {}),
    ...data,
    type: 'decision',
    tags: normalizeTags(data.tags, options.fallbackTags),
  };

  if (typeof normalized.source !== 'string' && options.source) {
    normalized.source = options.source;
  }

  if (envelope.summary) {
    normalized.content = envelope.summary;
  } else if (envelope.metadata) {
    delete normalized.content;
  }

  const content = buildDecisionContent(normalized);
  if (content) {
    normalized.content = content;
  }

  return normalized;
}

export function decisionBlockDataFromRecord(
  decision: DecisionRecord,
  options: {
    source?: string;
    fallbackTags?: string[];
    correlationId?: string;
    extraData?: Record<string, unknown>;
  } = {},
): DecisionChainData {
  const metadata: DecisionChainData = {
    id: decision.id,
    title: decision.title,
    choice: decision.chosen,
    chosen: decision.chosen,
    options: decision.options.length > 0 ? Array.from(new Set(decision.options)) : [],
    context: decision.context,
    confidence: decision.confidence,
    status: decision.status,
    refs: decision.refs,
    createdAt: decision.createdAt,
    updatedAt: decision.updatedAt,
    schemaVersion: decision.schemaVersion,
    correlationId: options.correlationId,
    source: options.source,
    ...options.extraData,
  };
  const summary = buildDecisionContent(metadata) ?? decision.title.trim();
  const tags = normalizeTags(metadata.tags, options.fallbackTags ?? ['decision']);

  return {
    ...metadata,
    type: 'decision',
    tags,
    content: `${summary}\n\n${DECISION_META_PREFIX}${JSON.stringify({
      ...metadata,
      type: 'decision',
      tags,
    })}`,
  };
}

export function decisionRecordFromBlock(block: Block): DecisionRecord | null {
  if (!block.data) return null;

  const data = normalizeDecisionBlockData(block.data);
  const title = typeof data.title === 'string' ? data.title.trim() : '';
  const choice =
    typeof data.choice === 'string'
      ? data.choice.trim()
      : typeof data.chosen === 'string'
        ? data.chosen.trim()
        : '';
  const context = typeof data.context === 'string' ? data.context : undefined;
  const options = normalizeOptions(data.options);
  const id =
    typeof data.id === 'string' && data.id.trim().length > 0
      ? data.id.trim()
      : `chain:${block.chain ?? 'decisions'}:${block.index ?? 0}`;
  const createdAt =
    typeof data.createdAt === 'string' && data.createdAt.trim().length > 0
      ? data.createdAt
      : (block.timestamp ?? new Date().toISOString());
  const updatedAt =
    typeof data.updatedAt === 'string' && data.updatedAt.trim().length > 0
      ? data.updatedAt
      : (block.timestamp ?? createdAt);
  const refs = Array.isArray(data.refs)
    ? data.refs.filter((ref): ref is string => typeof ref === 'string')
    : block.hash
      ? [`chain:${block.chain ?? 'decisions'}#${block.index ?? 0}`, `hash:${block.hash}`]
      : [`chain:${block.chain ?? 'decisions'}#${block.index ?? 0}`];

  if (!title && !choice && typeof data.content !== 'string') {
    return null;
  }

  const record = createDecision({
    id,
    title: title || choice || `Decision ${block.index ?? 0}`,
    options: options.length > 0 ? options : choice ? [choice] : [],
    chosen: choice || undefined,
    context,
    confidence: typeof data.confidence === 'number' ? data.confidence : 0.7,
    refs,
    nowIso: createdAt,
  });
  record.createdAt = createdAt;
  record.updatedAt = updatedAt;

  if (data.status === 'accepted' || data.status === 'implemented' || data.status === 'verified') {
    record.status = data.status;
  } else if (data.status === 'superseded' || data.status === 'rejected') {
    record.status = data.status;
  }

  return record;
}
