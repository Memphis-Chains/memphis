import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { buildRegistryInputJsonSchema } from '../../src/gateway/tool-json-schema.js';

describe('registry-backed JSON schemas', () => {
  it('derives provider/executor JSON schema from TOOL_REGISTRY and omits transport-only keys', () => {
    const schema = buildRegistryInputJsonSchema('memphis_journal', {
      propertyDescriptions: {
        content: 'Content to journal',
      },
    });

    expect(schema.type).toBe('object');
    expect(schema.properties?.content).toMatchObject({
      type: 'string',
      minLength: 1,
      description: 'Content to journal',
    });
    expect(schema.properties).not.toHaveProperty('approval_request_id');
    expect(schema.required).toEqual(['content']);
  });

  it('preserves registry constraints for case-entry payloads', () => {
    const schema = buildRegistryInputJsonSchema('memphis_case_append', {
      propertyDescriptions: {
        entry: 'Case chain entry payload',
      },
    });

    expect(schema.properties?.entry).toMatchObject({
      description: 'Case chain entry payload',
    });
    expect(schema.properties?.entry).toMatchObject({
      properties: {
        case_type: {
          enum: [
            'nominative',
            'genitive',
            'dative',
            'accusative',
            'instrumental',
            'locative',
            'ablative',
            'vocative',
          ],
        },
      },
    });
    expect(schema.properties?.case_type).toMatchObject({
      enum: [
        'nominative',
        'genitive',
        'dative',
        'accusative',
        'instrumental',
        'locative',
        'ablative',
        'vocative',
      ],
    });
    expect(schema.required).toBeUndefined();
  });

  it('preserves numeric registry constraints when deriving executor schemas', () => {
    const schema = buildRegistryInputJsonSchema('memphis_recall', {
      propertyDescriptions: {
        limit: 'Max results (1-50)',
      },
    });

    expect(schema.properties?.limit).toMatchObject({
      type: 'integer',
      exclusiveMinimum: 0,
      maximum: 50,
      description: 'Max results (1-50)',
    });
  });

  it('does not require fields whose registry schema supplies a default', () => {
    const schema = buildRegistryInputJsonSchema('memphis_lr_dashboard');

    expect(schema.properties?.action).toMatchObject({
      enum: ['status', 'add_entry'],
      default: 'status',
    });
    expect(schema.required ?? []).not.toContain('action');
  });

  it('fails loudly for unknown or schema-less tools', () => {
    expect(() => buildRegistryInputJsonSchema('memphis_nope')).toThrow(
      /No registry inputSchema/,
    );
  });

  it('keeps batch-4 executor tool schemas registry-derived instead of hand-maintained', () => {
    const domainsDir = join(process.cwd(), 'src/gateway/tool-executor/domains');
    const source = readdirSync(domainsDir)
      .filter((entry) => entry.endsWith('.ts'))
      .map((entry) => readFileSync(join(domainsDir, entry), 'utf8'))
      .join('\n');

    for (const toolName of [
      'memphis_recall',
      'memphis_search',
      'memphis_code_read',
      'memphis_brave_search',
      'memphis_chain_query',
      'memphis_grep',
      'memphis_glob',
    ]) {
      expect(source).toContain(`buildRegistryInputJsonSchema('${toolName}'`);
    }
  });
});
