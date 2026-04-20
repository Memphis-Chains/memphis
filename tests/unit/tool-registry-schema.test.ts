/**
 * Unit tests for the optional `inputSchema` extension to ToolMeta
 * (L3 Capability Registry — incremental polish, ROADMAP-CURRENT.md M6 / Phase L3).
 *
 * Pilot: 5 tier-0 tools carry a Zod schema describing their input shape.
 * Surfaces (TUI, GUI, MCP, custom apps) can use these schemata to render
 * forms, validate input before dispatch, and generate JSON schemas for LLM
 * tool-call signatures.
 *
 * The remaining 32 tool handlers in src/mcp/tools/ are intentionally NOT
 * touched in this PR — schema migration is incremental.
 */
import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { TOOL_REGISTRY } from '../../src/gateway/tool-registry.js';

const PILOT_TOOLS_WITH_SCHEMA = [
  'memphis_journal',
  'memphis_recall',
  'memphis_search',
  'memphis_decide',
  'memphis_health',
] as const;

describe('tool registry — inputSchema (pilot 5 tools)', () => {
  it('every pilot tool exposes a Zod inputSchema', () => {
    for (const name of PILOT_TOOLS_WITH_SCHEMA) {
      const meta = TOOL_REGISTRY[name];
      expect(meta, `${name} must be in TOOL_REGISTRY`).toBeDefined();
      expect(meta.inputSchema, `${name}.inputSchema must be present`).toBeDefined();
      // ZodSchema instances expose a `.parse` method
      expect(typeof meta.inputSchema!.parse).toBe('function');
    }
  });

  describe('memphis_journal schema', () => {
    const schema = TOOL_REGISTRY.memphis_journal.inputSchema!;

    it('accepts valid input', () => {
      expect(() => schema.parse({ content: 'hello world' })).not.toThrow();
      expect(() => schema.parse({ content: 'hi', tags: ['note', 'test'] })).not.toThrow();
    });

    it('rejects missing content', () => {
      expect(() => schema.parse({})).toThrow();
      expect(() => schema.parse({ tags: ['x'] })).toThrow();
    });

    it('rejects empty content', () => {
      expect(() => schema.parse({ content: '' })).toThrow();
    });

    it('rejects unknown fields (strict)', () => {
      expect(() => schema.parse({ content: 'hi', extra: 'reject me' })).toThrow();
    });
  });

  describe('memphis_recall schema', () => {
    const schema = TOOL_REGISTRY.memphis_recall.inputSchema!;

    it('accepts valid input', () => {
      expect(() => schema.parse({ query: 'meaning of life' })).not.toThrow();
      expect(() => schema.parse({ query: 'q', limit: 10 })).not.toThrow();
      expect(() =>
        schema.parse({ query: 'q', limit: 10, approval_request_id: 'req-1' }),
      ).not.toThrow();
    });

    it('rejects missing query', () => {
      expect(() => schema.parse({})).toThrow();
    });

    it('rejects negative or zero limit', () => {
      expect(() => schema.parse({ query: 'q', limit: 0 })).toThrow();
      expect(() => schema.parse({ query: 'q', limit: -1 })).toThrow();
    });

    it('rejects limit above 50 (aligned with MCP validator)', () => {
      expect(() => schema.parse({ query: 'q', limit: 51 })).toThrow();
    });

    it('rejects tags / chain (not honored by dispatcher — Codex P2)', () => {
      expect(() => schema.parse({ query: 'q', tags: ['t'] })).toThrow();
      expect(() => schema.parse({ query: 'q', chain: 'journal' })).toThrow();
    });
  });

  describe('memphis_search schema', () => {
    const schema = TOOL_REGISTRY.memphis_search.inputSchema!;

    it('accepts valid input', () => {
      expect(() => schema.parse({ query: 'phrase' })).not.toThrow();
      expect(() => schema.parse({ query: 'p', limit: 5, chain: 'decisions' })).not.toThrow();
      expect(() =>
        schema.parse({ query: 'p', limit: 5, chain: 'decisions', approval_request_id: 'req-2' }),
      ).not.toThrow();
    });

    it('rejects missing query', () => {
      expect(() => schema.parse({})).toThrow();
    });

    it('rejects limit above 50 (aligned with MCP validator)', () => {
      expect(() => schema.parse({ query: 'q', limit: 51 })).toThrow();
    });

    it('rejects empty chain (aligned with MCP validator)', () => {
      expect(() => schema.parse({ query: 'q', chain: '' })).toThrow();
    });
  });

  describe('memphis_decide schema', () => {
    const schema = TOOL_REGISTRY.memphis_decide.inputSchema!;

    it('accepts valid input', () => {
      expect(() => schema.parse({ title: 'Choice A', choice: 'A' })).not.toThrow();
      expect(() => schema.parse({ title: 't', choice: 'c', context: 'why' })).not.toThrow();
    });

    it('rejects missing required fields', () => {
      expect(() => schema.parse({ title: 'no choice' })).toThrow();
      expect(() => schema.parse({ choice: 'no title' })).toThrow();
    });
  });

  describe('memphis_health schema', () => {
    const schema = TOOL_REGISTRY.memphis_health.inputSchema!;

    it('accepts empty input', () => {
      expect(() => schema.parse({})).not.toThrow();
    });

    it('accepts approval_request_id (approval-gate compatibility)', () => {
      expect(() => schema.parse({ approval_request_id: 'req-3' })).not.toThrow();
    });

    it('rejects unknown field (strict)', () => {
      expect(() => schema.parse({ foo: 'bar' })).toThrow();
    });
  });

  describe('non-pilot tools intentionally lack inputSchema', () => {
    it('keeps schema migration incremental', () => {
      const withSchema = Object.values(TOOL_REGISTRY).filter((m) => m.inputSchema !== undefined);
      // Only the 5 pilot tools should have a schema in this PR.
      expect(withSchema).toHaveLength(PILOT_TOOLS_WITH_SCHEMA.length);
      const names = withSchema.map((m) => m.name).sort();
      expect(names).toEqual([...PILOT_TOOLS_WITH_SCHEMA].sort());
    });
  });

  describe('schema is structurally compatible with z.ZodTypeAny', () => {
    it('all pilot schemata return safeParse with success boolean', () => {
      for (const name of PILOT_TOOLS_WITH_SCHEMA) {
        const schema = TOOL_REGISTRY[name].inputSchema!;
        const result = schema.safeParse(undefined);
        expect(typeof result.success).toBe('boolean');
        expect(result.success).toBe(false);
      }
    });

    it('schema has a stable identity (same reference across reads)', () => {
      // Surface adapters may cache schema references — assert identity is stable.
      const a = TOOL_REGISTRY.memphis_journal.inputSchema;
      const b = TOOL_REGISTRY.memphis_journal.inputSchema;
      expect(a).toBe(b);
    });

    it('z import is functional in this test (sanity)', () => {
      const local = z.object({ x: z.string() });
      expect(() => local.parse({ x: 'ok' })).not.toThrow();
    });
  });
});
