import { z } from 'zod';

import { TOOL_REGISTRY } from './tool-registry.js';
import type { ChatToolDefinition } from '../providers/index.js';

const TRANSPORT_ONLY_INPUT_KEYS = new Set(['approval_request_id']);

export type RegistryInputJsonSchemaOptions = {
  /**
   * Executor/provider schemas can keep model-facing property descriptions
   * while still deriving keys, required fields, types, and constraints from
   * TOOL_REGISTRY.
   */
  propertyDescriptions?: Record<string, string>;
  omitTransportKeys?: boolean;
};

function cloneJsonObject(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return { ...(value as Record<string, unknown>) };
}

function normalizeRequired(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const required = value.filter((key): key is string => typeof key === 'string');
  return required.length > 0 ? required : undefined;
}

function semanticRequiredKeys(schema: unknown): Set<string> | undefined {
  if (!schema || typeof schema !== 'object') return undefined;
  const maybeShape = (schema as { shape?: unknown; _def?: { shape?: unknown } }).shape
    ?? (schema as { _def?: { shape?: unknown } })._def?.shape;
  const shape = typeof maybeShape === 'function' ? maybeShape() : maybeShape;
  if (!shape || typeof shape !== 'object' || Array.isArray(shape)) return undefined;

  const required = new Set<string>();
  for (const [key, fieldSchema] of Object.entries(shape as Record<string, unknown>)) {
    const maybeOptional = fieldSchema as { isOptional?: unknown };
    if (typeof maybeOptional.isOptional === 'function' && maybeOptional.isOptional()) continue;
    required.add(key);
  }
  return required;
}

export function buildRegistryInputJsonSchema(
  toolName: string,
  options: RegistryInputJsonSchemaOptions = {},
): ChatToolDefinition['inputSchema'] {
  const meta = TOOL_REGISTRY[toolName];
  if (!meta?.inputSchema) {
    throw new Error(`No registry inputSchema found for tool ${toolName}`);
  }

  const raw = z.toJSONSchema(meta.inputSchema) as Record<string, unknown>;
  const schema = cloneJsonObject(raw);
  delete schema.$schema;

  const properties = cloneJsonObject(schema.properties);
  const semanticRequired = semanticRequiredKeys(meta.inputSchema);
  const required = new Set(
    (normalizeRequired(schema.required) ?? []).filter(
      (key) => semanticRequired === undefined || semanticRequired.has(key),
    ),
  );
  const omitTransportKeys = options.omitTransportKeys ?? true;

  if (omitTransportKeys) {
    for (const key of TRANSPORT_ONLY_INPUT_KEYS) {
      delete properties[key];
      required.delete(key);
    }
  }

  for (const [key, description] of Object.entries(options.propertyDescriptions ?? {})) {
    if (!properties[key] || typeof properties[key] !== 'object' || Array.isArray(properties[key])) {
      continue;
    }
    properties[key] = {
      ...(properties[key] as Record<string, unknown>),
      description,
    };
  }

  schema.properties = properties;
  const normalizedRequired = normalizeRequired(Array.from(required));
  if (normalizedRequired) {
    schema.required = normalizedRequired;
  } else {
    delete schema.required;
  }

  return schema;
}
