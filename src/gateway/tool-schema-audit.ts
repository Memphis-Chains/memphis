import { z } from 'zod';

import { createInProcessToolExecutor } from './tool-executor.js';
import { TOOL_REGISTRY } from './tool-registry.js';
import { createMemphisMcpServer } from '../mcp/server.js';
import type { ChatToolDefinition } from '../providers/index.js';

const IGNORED_SCHEMA_KEYS = new Set(['approval_request_id']);
const JSON_SCHEMA_SAFE_INTEGER_MAX = 9007199254740991;
const JSON_SCHEMA_SAFE_INTEGER_MIN = -9007199254740991;

export type ToolSchemaAuditEntry = {
  name: string;
  registryKeys: string[];
  executorKeys: string[];
  mcpKeys: string[];
  missingFromRegistry: string[];
  missingFromExecutor: string[];
  missingFromMcp: string[];
};

export type ToolSchemaRequiredAuditEntry = {
  name: string;
  registryRequiredKeys: string[];
  executorRequiredKeys: string[];
  mcpRequiredKeys: string[];
  missingRequiredFromRegistry: string[];
  missingRequiredFromExecutor: string[];
  missingRequiredFromMcp: string[];
};

export type ToolSchemaTypeAuditEntry = {
  name: string;
  key: string;
  registryType: string;
  executorType: string;
  mcpType: string;
};

export type ToolSchemaConstraintAuditEntry = {
  name: string;
  keyPath: string;
  registryConstraints: string;
  executorConstraints: string;
  mcpConstraints: string;
};

export type ToolSchemaAuditReport = {
  ok: boolean;
  checked: number;
  mismatches: ToolSchemaAuditEntry[];
  requiredMismatches: ToolSchemaRequiredAuditEntry[];
  typeMismatches: ToolSchemaTypeAuditEntry[];
  constraintMismatches: ToolSchemaConstraintAuditEntry[];
  missingRegistrySchema: string[];
  missingExecutorSchema: string[];
  missingMcpSchema: string[];
};

function fullFeatureEnv(rawEnv: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const features = new Set(
    (rawEnv.MEMPHIS_FEATURES ?? '')
      .split(/[,\s]+/u)
      .map((value) => value.trim())
      .filter(Boolean),
  );
  features.add('experimental-tools');
  return {
    ...rawEnv,
    MEMPHIS_FEATURES: Array.from(features).join(','),
  };
}

function normalizeKeys(keys: Iterable<string>): string[] {
  return Array.from(new Set(keys))
    .filter((key) => !IGNORED_SCHEMA_KEYS.has(key))
    .sort((a, b) => a.localeCompare(b));
}

function zodObjectShape(schema: unknown): Record<string, unknown> | undefined {
  if (!schema || typeof schema !== 'object') return undefined;
  const maybeShape = (schema as { shape?: unknown; _def?: { shape?: unknown } }).shape
    ?? (schema as { _def?: { shape?: unknown } })._def?.shape;
  const shape = typeof maybeShape === 'function' ? maybeShape() : maybeShape;
  if (!shape || typeof shape !== 'object' || Array.isArray(shape)) return undefined;
  return shape as Record<string, unknown>;
}

function zodObjectKeys(schema: unknown): string[] | undefined {
  const shape = zodObjectShape(schema);
  if (!shape) return undefined;
  return normalizeKeys(Object.keys(shape));
}

function zodObjectRequiredKeys(schema: unknown): string[] | undefined {
  const shape = zodObjectShape(schema);
  if (!shape) return undefined;

  const requiredKeys: string[] = [];
  for (const [key, fieldSchema] of Object.entries(shape)) {
    if (IGNORED_SCHEMA_KEYS.has(key)) continue;
    const maybeOptional = fieldSchema as { isOptional?: unknown };
    if (typeof maybeOptional.isOptional === 'function') {
      if (!maybeOptional.isOptional()) requiredKeys.push(key);
      continue;
    }
    requiredKeys.push(key);
  }
  return normalizeKeys(requiredKeys);
}

function unwrapZodSchema(schema: unknown): unknown {
  let current = schema;
  for (let i = 0; i < 8; i += 1) {
    if (!current || typeof current !== 'object') return current;
    const constructorName = (current as { constructor?: { name?: string } }).constructor?.name;
    const def = (current as { _def?: Record<string, unknown>; def?: Record<string, unknown> })._def
      ?? (current as { def?: Record<string, unknown> }).def;
    if (
      constructorName === 'ZodOptional' ||
      constructorName === 'ZodDefault' ||
      constructorName === 'ZodNullable' ||
      constructorName === 'ZodCatch'
    ) {
      current = def?.innerType;
      continue;
    }
    if (constructorName === 'ZodEffects') {
      current = def?.schema;
      continue;
    }
    if (constructorName === 'ZodPipeline' || constructorName === 'ZodPipe') {
      current = def?.out ?? def?.in;
      continue;
    }
    return current;
  }
  return current;
}

function zodTypeSignature(schema: unknown): string {
  const unwrapped = unwrapZodSchema(schema);
  if (!unwrapped || typeof unwrapped !== 'object') return 'unknown';
  const constructorName = (unwrapped as { constructor?: { name?: string } }).constructor?.name;
  const def = (unwrapped as { _def?: Record<string, unknown>; def?: Record<string, unknown> })._def
    ?? (unwrapped as { def?: Record<string, unknown> }).def;
  switch (constructorName) {
    case 'ZodString':
    case 'ZodEnum':
    case 'ZodNativeEnum':
    case 'ZodLiteral':
      return 'string';
    case 'ZodNumber':
      return 'number';
    case 'ZodBoolean':
      return 'boolean';
    case 'ZodArray':
      return 'array';
    case 'ZodObject':
    case 'ZodRecord':
      return 'object';
    case 'ZodUnion':
    case 'ZodDiscriminatedUnion':
      if (Array.isArray(def?.options)) {
        const optionSignatures = new Set(def.options.map((option) => zodTypeSignature(option)));
        if (optionSignatures.size === 1) return Array.from(optionSignatures)[0] ?? 'union';
      }
      return 'union';
    case 'ZodUnknown':
    case 'ZodAny':
      return 'unknown';
    default:
      return constructorName ?? 'unknown';
  }
}

function zodObjectTypeSignatures(schema: unknown): Record<string, string> | undefined {
  const shape = zodObjectShape(schema);
  if (!shape) return undefined;
  const signatures: Record<string, string> = {};
  for (const [key, fieldSchema] of Object.entries(shape)) {
    if (IGNORED_SCHEMA_KEYS.has(key)) continue;
    signatures[key] = zodTypeSignature(fieldSchema);
  }
  return signatures;
}

function jsonSchemaObjectKeys(schema: ChatToolDefinition['inputSchema']): string[] | undefined {
  if (!schema || typeof schema !== 'object') return undefined;
  const properties = (schema as { properties?: unknown }).properties;
  if (!properties || typeof properties !== 'object' || Array.isArray(properties)) return undefined;
  return normalizeKeys(Object.keys(properties));
}

function jsonSchemaRequiredKeys(schema: ChatToolDefinition['inputSchema']): string[] | undefined {
  if (!schema || typeof schema !== 'object') return undefined;
  const properties = (schema as { properties?: unknown }).properties;
  if (!properties || typeof properties !== 'object' || Array.isArray(properties)) return undefined;
  const required = (schema as { required?: unknown }).required;
  if (!Array.isArray(required)) return [];
  return normalizeKeys(required.filter((key): key is string => typeof key === 'string'));
}

function jsonSchemaTypeSignature(propertySchema: unknown): string {
  if (!propertySchema || typeof propertySchema !== 'object') return 'unknown';
  const property = propertySchema as {
    type?: unknown;
    enum?: unknown;
    anyOf?: unknown;
    oneOf?: unknown;
  };
  const unionOptions = Array.isArray(property.anyOf)
    ? property.anyOf
    : Array.isArray(property.oneOf)
      ? property.oneOf
      : undefined;
  if (unionOptions) {
    const optionSignatures = new Set(unionOptions.map((option) => jsonSchemaTypeSignature(option)));
    if (optionSignatures.size === 1) return Array.from(optionSignatures)[0] ?? 'union';
    return 'union';
  }
  if (Array.isArray(property.type)) {
    return property.type
      .filter((value): value is string => typeof value === 'string')
      .map((value) => (value === 'integer' ? 'number' : value))
      .sort((a, b) => a.localeCompare(b))
      .join('|') || 'unknown';
  }
  if (property.type === 'integer') return 'number';
  if (typeof property.type === 'string') return property.type;
  if (Array.isArray(property.enum)) return 'string';
  return 'unknown';
}

function jsonSchemaTypeSignatures(
  schema: ChatToolDefinition['inputSchema'],
): Record<string, string> | undefined {
  if (!schema || typeof schema !== 'object') return undefined;
  const properties = (schema as { properties?: unknown }).properties;
  if (!properties || typeof properties !== 'object' || Array.isArray(properties)) return undefined;
  const signatures: Record<string, string> = {};
  for (const [key, propertySchema] of Object.entries(properties)) {
    if (IGNORED_SCHEMA_KEYS.has(key)) continue;
    signatures[key] = jsonSchemaTypeSignature(propertySchema);
  }
  return signatures;
}

function zodToJsonSchema(schema: unknown): Record<string, unknown> | undefined {
  if (!schema || typeof schema !== 'object') return undefined;
  try {
    const jsonSchema = z.toJSONSchema(schema as z.ZodTypeAny) as Record<string, unknown>;
    delete jsonSchema.$schema;
    return jsonSchema;
  } catch {
    return undefined;
  }
}

function normalizeConstraintValue(key: string, value: unknown, propertySchema: Record<string, unknown>): unknown {
  const type = propertySchema.type;
  if (key === 'maximum' && value === JSON_SCHEMA_SAFE_INTEGER_MAX) return undefined;
  if (key === 'minimum' && value === JSON_SCHEMA_SAFE_INTEGER_MIN) return undefined;
  if (type === 'integer' && key === 'exclusiveMinimum' && value === 0) return 1;
  if (type === 'integer' && key === 'minimum' && value === 1) return 1;
  if (Array.isArray(value)) {
    return value
      .filter((item): item is string | number | boolean | null =>
        item === null ||
        typeof item === 'string' ||
        typeof item === 'number' ||
        typeof item === 'boolean',
      )
      .sort((a, b) => String(a).localeCompare(String(b)));
  }
  return value;
}

function primitiveConstraintSignature(propertySchema: unknown): string {
  if (!propertySchema || typeof propertySchema !== 'object' || Array.isArray(propertySchema)) {
    return '';
  }
  const property = propertySchema as Record<string, unknown>;
  const keys = [
    'type',
    'enum',
    'const',
    'format',
    'minimum',
    'exclusiveMinimum',
    'maximum',
    'exclusiveMaximum',
    'minLength',
    'maxLength',
    'minItems',
    'maxItems',
    'additionalProperties',
  ];
  const parts: string[] = [];
  for (const key of keys) {
    if (!(key in property)) continue;
    const canonicalKey =
      property.type === 'integer' && key === 'exclusiveMinimum' && property[key] === 0
        ? 'minimum'
        : key;
    const normalized = normalizeConstraintValue(key, property[key], property);
    if (normalized === undefined) continue;
    parts.push(`${canonicalKey}=${JSON.stringify(normalized)}`);
  }
  return parts.join(';');
}

function readJsonSchemaProperties(schema: unknown): Record<string, unknown> | undefined {
  if (!schema || typeof schema !== 'object' || Array.isArray(schema)) return undefined;
  const properties = (schema as { properties?: unknown }).properties;
  if (!properties || typeof properties !== 'object' || Array.isArray(properties)) return undefined;
  return properties as Record<string, unknown>;
}

function collectJsonSchemaConstraintSignatures(
  schema: unknown,
  prefix = '',
): Record<string, string> {
  const result: Record<string, string> = {};
  const properties = readJsonSchemaProperties(schema);
  if (!properties) return result;

  for (const [key, propertySchema] of Object.entries(properties)) {
    if (!prefix && IGNORED_SCHEMA_KEYS.has(key)) continue;
    const keyPath = prefix ? `${prefix}.${key}` : key;
    const signature = primitiveConstraintSignature(propertySchema);
    if (signature) result[keyPath] = signature;

    Object.assign(result, collectJsonSchemaConstraintSignatures(propertySchema, keyPath));

    if (propertySchema && typeof propertySchema === 'object' && !Array.isArray(propertySchema)) {
      const items = (propertySchema as { items?: unknown }).items;
      if (items) {
        const arrayPrefix = `${keyPath}[]`;
        const itemSignature = primitiveConstraintSignature(items);
        if (itemSignature) result[arrayPrefix] = itemSignature;
        Object.assign(result, collectJsonSchemaConstraintSignatures(items, arrayPrefix));
      }
    }
  }

  return result;
}

function jsonSchemaConstraintSignatures(schema: unknown): Record<string, string> | undefined {
  if (!schema || typeof schema !== 'object') return undefined;
  return collectJsonSchemaConstraintSignatures(schema);
}

type McpToolSnapshot = {
  inputSchema?: unknown;
};

type McpServerSnapshot = {
  _registeredTools?: Record<string, McpToolSnapshot>;
};

function readMcpRegisteredTools(rawEnv: NodeJS.ProcessEnv): Map<string, McpToolSnapshot> {
  const server = createMemphisMcpServer(undefined, rawEnv) as unknown as McpServerSnapshot;
  return new Map(Object.entries(server._registeredTools ?? {}));
}

function unionKeys(...keySets: string[][]): string[] {
  return normalizeKeys(keySets.flat());
}

export function buildToolSchemaAuditReport(
  rawEnv: NodeJS.ProcessEnv = process.env,
): ToolSchemaAuditReport {
  const env = fullFeatureEnv(rawEnv);
  const executorTools = createInProcessToolExecutor({ rawEnv: env }).listTools();
  const executorByName = new Map(executorTools.map((tool) => [tool.name, tool]));
  const mcpByName = readMcpRegisteredTools(env);

  const mismatches: ToolSchemaAuditEntry[] = [];
  const requiredMismatches: ToolSchemaRequiredAuditEntry[] = [];
  const typeMismatches: ToolSchemaTypeAuditEntry[] = [];
  const constraintMismatches: ToolSchemaConstraintAuditEntry[] = [];
  const missingRegistrySchema: string[] = [];
  const missingExecutorSchema: string[] = [];
  const missingMcpSchema: string[] = [];

  for (const meta of Object.values(TOOL_REGISTRY).sort((a, b) => a.name.localeCompare(b.name))) {
    const executorTool = executorByName.get(meta.name);
    const mcpTool = mcpByName.get(meta.name);
    const registryKeys = zodObjectKeys(meta.inputSchema);
    const executorKeys = executorTool ? jsonSchemaObjectKeys(executorTool.inputSchema) : undefined;
    const mcpKeys = mcpTool ? zodObjectKeys(mcpTool.inputSchema) : undefined;
    const registryRequiredKeys = zodObjectRequiredKeys(meta.inputSchema);
    const executorRequiredKeys = executorTool
      ? jsonSchemaRequiredKeys(executorTool.inputSchema)
      : undefined;
    const mcpRequiredKeys = mcpTool ? zodObjectRequiredKeys(mcpTool.inputSchema) : undefined;
    const registryTypes = zodObjectTypeSignatures(meta.inputSchema);
    const executorTypes = executorTool ? jsonSchemaTypeSignatures(executorTool.inputSchema) : undefined;
    const mcpTypes = mcpTool ? zodObjectTypeSignatures(mcpTool.inputSchema) : undefined;
    const registryJsonSchema = zodToJsonSchema(meta.inputSchema);
    const executorJsonSchema = executorTool?.inputSchema;
    const mcpJsonSchema = mcpTool ? zodToJsonSchema(mcpTool.inputSchema) : undefined;
    const registryConstraints = jsonSchemaConstraintSignatures(registryJsonSchema);
    const executorConstraints = executorTool
      ? jsonSchemaConstraintSignatures(executorJsonSchema)
      : undefined;
    const mcpConstraints = mcpTool ? jsonSchemaConstraintSignatures(mcpJsonSchema) : undefined;

    if (!registryKeys) {
      missingRegistrySchema.push(meta.name);
      continue;
    }
    if (!executorKeys) {
      missingExecutorSchema.push(meta.name);
      continue;
    }
    if (!mcpKeys) {
      missingMcpSchema.push(meta.name);
      continue;
    }
    if (
      !registryRequiredKeys ||
      !executorRequiredKeys ||
      !mcpRequiredKeys ||
      !registryTypes ||
      !executorTypes ||
      !mcpTypes
    ) {
      continue;
    }

    const registrySet = new Set(registryKeys);
    const executorSet = new Set(executorKeys);
    const mcpSet = new Set(mcpKeys);
    const allKeys = unionKeys(registryKeys, executorKeys, mcpKeys);
    const missingFromRegistry = allKeys.filter((key) => !registrySet.has(key));
    const missingFromExecutor = allKeys.filter((key) => !executorSet.has(key));
    const missingFromMcp = allKeys.filter((key) => !mcpSet.has(key));
    if (
      missingFromRegistry.length > 0 ||
      missingFromExecutor.length > 0 ||
      missingFromMcp.length > 0
    ) {
      mismatches.push({
        name: meta.name,
        registryKeys,
        executorKeys,
        mcpKeys,
        missingFromRegistry,
        missingFromExecutor,
        missingFromMcp,
      });
    }

    const registryRequiredSet = new Set(registryRequiredKeys);
    const executorRequiredSet = new Set(executorRequiredKeys);
    const mcpRequiredSet = new Set(mcpRequiredKeys);
    const allRequiredKeys = unionKeys(registryRequiredKeys, executorRequiredKeys, mcpRequiredKeys);
    const missingRequiredFromRegistry = allRequiredKeys.filter(
      (key) => !registryRequiredSet.has(key),
    );
    const missingRequiredFromExecutor = allRequiredKeys.filter(
      (key) => !executorRequiredSet.has(key),
    );
    const missingRequiredFromMcp = allRequiredKeys.filter((key) => !mcpRequiredSet.has(key));

    if (
      missingRequiredFromRegistry.length > 0 ||
      missingRequiredFromExecutor.length > 0 ||
      missingRequiredFromMcp.length > 0
    ) {
      requiredMismatches.push({
        name: meta.name,
        registryRequiredKeys,
        executorRequiredKeys,
        mcpRequiredKeys,
        missingRequiredFromRegistry,
        missingRequiredFromExecutor,
        missingRequiredFromMcp,
      });
    }

    for (const key of allKeys) {
      const registryType = registryTypes[key] ?? 'missing';
      const executorType = executorTypes[key] ?? 'missing';
      const mcpType = mcpTypes[key] ?? 'missing';
      if (registryType !== executorType || registryType !== mcpType) {
        typeMismatches.push({
          name: meta.name,
          key,
          registryType,
          executorType,
          mcpType,
        });
      }
    }

    if (registryConstraints && executorConstraints && mcpConstraints) {
      const allConstraintKeys = unionKeys(
        Object.keys(registryConstraints),
        Object.keys(executorConstraints),
        Object.keys(mcpConstraints),
      );
      for (const keyPath of allConstraintKeys) {
        const registryConstraint = registryConstraints[keyPath] ?? '';
        const executorConstraint = executorConstraints[keyPath] ?? '';
        const mcpConstraint = mcpConstraints[keyPath] ?? '';
        if (registryConstraint !== executorConstraint || registryConstraint !== mcpConstraint) {
          constraintMismatches.push({
            name: meta.name,
            keyPath,
            registryConstraints: registryConstraint || '<none>',
            executorConstraints: executorConstraint || '<none>',
            mcpConstraints: mcpConstraint || '<none>',
          });
        }
      }
    }
  }

  return {
    ok:
      mismatches.length === 0 &&
      requiredMismatches.length === 0 &&
      typeMismatches.length === 0 &&
      missingRegistrySchema.length === 0 &&
      missingExecutorSchema.length === 0 &&
      missingMcpSchema.length === 0,
    checked: Object.keys(TOOL_REGISTRY).length,
    mismatches,
    requiredMismatches,
    typeMismatches,
    constraintMismatches,
    missingRegistrySchema,
    missingExecutorSchema,
    missingMcpSchema,
  };
}
