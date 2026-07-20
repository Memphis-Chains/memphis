import { AppError } from '../../core/errors.js';

export type ToolInput = Record<string, unknown>;
type SoulReadSection = 'user' | 'self' | 'context' | 'all';

const SOUL_UPDATE_ARRAY_FIELDS = {
  user: ['languages', 'preferences', 'expertise', 'integrations'],
  self: ['strengths', 'learnings', 'evolvedCapabilities'],
  context: ['recentDecisions'],
} as const;

function normalizeSoulUpdateArrayField(value: unknown): unknown {
  if (Array.isArray(value)) return value;
  if (!value || typeof value !== 'object') return value;
  const entries = Object.entries(value as Record<string, unknown>);
  if (entries.length === 0) return value;
  const ordered = entries.every(([key]) => /^\d+$/.test(key))
    ? entries.sort(([left], [right]) => Number(left) - Number(right))
    : entries;
  const strings = ordered
    .map(([, entry]) => entry)
    .filter((entry): entry is string => typeof entry === 'string');
  return strings.length === entries.length ? strings : value;
}

export function normalizeSoulWriteUpdatesForToolCall(
  updates: Record<string, unknown>,
): Record<string, unknown> {
  const normalized: Record<string, unknown> = { ...updates };
  for (const [section, fields] of Object.entries(SOUL_UPDATE_ARRAY_FIELDS)) {
    const sectionValue = normalized[section];
    if (!sectionValue || typeof sectionValue !== 'object' || Array.isArray(sectionValue)) continue;
    const nextSection = { ...(sectionValue as Record<string, unknown>) };
    for (const field of fields) {
      if (Object.hasOwn(nextSection, field)) {
        nextSection[field] = normalizeSoulUpdateArrayField(nextSection[field]);
      }
    }
    normalized[section] = nextSection;
  }
  return normalized;
}

export function normalizeCaseQueryForToolCall(
  query: Record<string, unknown>,
): Record<string, unknown> {
  const normalized = { ...query };
  if (typeof normalized.limit === 'string' && /^\s*\d+\s*$/.test(normalized.limit)) {
    normalized.limit = Number(normalized.limit.trim());
  }
  return normalized;
}

export function requiredString(args: ToolInput, key: string): string {
  const value = args[key];
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new AppError('VALIDATION_ERROR', `tool ${key} must be a non-empty string`, 400);
  }
  return value;
}

export function optionalString(args: ToolInput, key: string): string | undefined {
  const value = args[key];
  return typeof value === 'string' && value.trim().length > 0 ? value : undefined;
}

export function optionalStringLength(
  args: ToolInput,
  key: string,
  length: number,
): string | undefined {
  const value = optionalString(args, key);
  if (value !== undefined && value.length !== length) {
    throw new AppError('VALIDATION_ERROR', `tool ${key} must be ${length} characters`, 400);
  }
  return value;
}

export function optionalStringArray(args: ToolInput, key: string): string[] | undefined {
  const value = args[key];
  if (!Array.isArray(value)) return undefined;
  const strings = value.filter(
    (item): item is string => typeof item === 'string' && item.trim().length > 0,
  );
  return strings.length > 0 ? strings : undefined;
}

export function optionalNumber(args: ToolInput, key: string): number | undefined {
  const value = args[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

export function optionalNonnegativeInteger(args: ToolInput, key: string): number | undefined {
  const value = optionalNumber(args, key);
  if (value !== undefined && (!Number.isInteger(value) || value < 0)) {
    throw new AppError('VALIDATION_ERROR', `tool ${key} must be a non-negative integer`, 400);
  }
  return value;
}

export function optionalIntegerInRange(
  args: ToolInput,
  key: string,
  min: number,
  max?: number,
): number | undefined {
  const value = optionalNumber(args, key);
  if (value === undefined) return undefined;
  if (!Number.isInteger(value) || value < min || (max !== undefined && value > max)) {
    const range = max === undefined ? `>= ${min}` : `between ${min} and ${max}`;
    throw new AppError('VALIDATION_ERROR', `tool ${key} must be an integer ${range}`, 400);
  }
  return value;
}

export function optionalBoolean(args: ToolInput, key: string): boolean | undefined {
  const value = args[key];
  return typeof value === 'boolean' ? value : undefined;
}

export function requiredRecord(args: ToolInput, key: string): Record<string, unknown> {
  const value = args[key];
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new AppError('VALIDATION_ERROR', `tool ${key} must be an object`, 400);
  }
  return value as Record<string, unknown>;
}

export function optionalSoulReadSection(args: ToolInput, key: string): SoulReadSection | undefined {
  const value = args[key];
  return value === 'user' || value === 'self' || value === 'context' || value === 'all'
    ? value
    : undefined;
}
