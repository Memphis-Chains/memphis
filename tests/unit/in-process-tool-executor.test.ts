import { describe, expect, it, vi } from 'vitest';

import {
  createInProcessToolExecutor,
  normalizeCaseQueryForToolCall,
  normalizeSoulWriteUpdatesForToolCall,
} from '../../src/gateway/tool-executor.js';

describe('in-process tool executor', () => {
  it('exposes the same core soul/case surface as MCP', () => {
    const executor = createInProcessToolExecutor();
    const names = executor
      .listTools()
      .map((tool) => tool.name)
      .sort();

    expect(names).toContain('memphis_soul_read');
    expect(names).toContain('memphis_soul_write');
    expect(names).toContain('memphis_case_append');
    expect(names).toContain('memphis_case_query');
    expect(names).toContain('memphis_deploy');
    expect(names).toContain('memphis_self_modify');
    expect(names).toContain('memphis_search');
  });

  it('publishes runtime tool metadata for batching decisions', () => {
    const executor = createInProcessToolExecutor();
    const toolMap = new Map(executor.listTools().map((tool) => [tool.name, tool]));

    expect(toolMap.get('memphis_recall')).toMatchObject({
      isConcurrencySafe: true,
      isReadOnly: true,
    });
    // Kartograf inference is read-only (no chain writes, no FS mutation)
    // and concurrency-safe (singleton session is internally serialized).
    expect(toolMap.get('memphis_kartograf')).toMatchObject({
      isConcurrencySafe: true,
      isReadOnly: true,
    });
    expect(toolMap.get('memphis_search')).toMatchObject({
      isConcurrencySafe: true,
      isReadOnly: true,
    });
    expect(toolMap.get('memphis_exec')).toMatchObject({
      isConcurrencySafe: false,
      isDestructive: true,
    });
    expect(executor.maxParallel).toBe(4);
  });

  it('keeps preview tools disabled unless the feature flag is enabled', () => {
    const stableExecutor = createInProcessToolExecutor({ rawEnv: {} });
    const stableNames = stableExecutor.listTools().map((tool) => tool.name);
    expect(stableNames).not.toContain('memphis_chain_query');
    expect(stableNames).not.toContain('memphis_providers');
    expect(stableNames).not.toContain('memphis_system_info');

    const experimentalExecutor = createInProcessToolExecutor({
      rawEnv: { MEMPHIS_FEATURES: 'experimental-tools' },
    });
    const experimentalNames = experimentalExecutor.listTools().map((tool) => tool.name);
    expect(experimentalNames).toContain('memphis_chain_query');
    expect(experimentalNames).toContain('memphis_providers');
    expect(experimentalNames).toContain('memphis_system_info');
  });

  it('rejects preview tool execution when the feature flag is disabled', async () => {
    const executor = createInProcessToolExecutor({ rawEnv: {} });
    const result = await executor.execute({
      id: 'call-preview-disabled',
      name: 'memphis_system_info',
      arguments: {},
    });

    expect(JSON.parse(result)).toEqual({
      error: 'unknown tool: memphis_system_info',
    });
  });

  // Live bug 2026-05-08: a tool call from Mode B (LLM-direct) carrying a
  // schema-violating `updates` payload would either silently drop the
  // bogus fields (operator saw `memory: null`) or crash deep in
  // dedupeAppend with "additions is not iterable". The validateInput
  // gate should surface a helpful error to the caller in both cases.
  // executeTool re-throws validation errors (see tool-executor.ts:1405),
  // so the assertion uses `.rejects.toThrow`.
  it('rejects memphis_soul_write with non-array list field', async () => {
    const executor = createInProcessToolExecutor();
    await expect(
      executor.execute({
        id: 'call-soul-write-bad-shape',
        name: 'memphis_soul_write',
        arguments: {
          updates: { user: { languages: 'Polish' } },
        },
      }),
    ).rejects.toThrow(/memphis_soul_write[\s\S]*user\.languages/);
  });

  it('normalizes LLM object-encoded soul_write array fields before schema validation', () => {
    const normalized = normalizeSoulWriteUpdatesForToolCall({
      user: { languages: { 1: 'en', 0: 'pl' } },
      self: { learnings: { first: 'read the schema first' } },
      context: { recentDecisions: { 0: 'keep public chat tier 0' } },
    });

    expect(normalized).toEqual({
      user: { languages: ['pl', 'en'] },
      self: { learnings: ['read the schema first'] },
      context: { recentDecisions: ['keep public chat tier 0'] },
    });
  });

  it('does not normalize scalar soul_write array fields', () => {
    const normalized = normalizeSoulWriteUpdatesForToolCall({
      user: { languages: 'Polish' },
    });

    expect(normalized).toEqual({
      user: { languages: 'Polish' },
    });
  });

  it('rejects memphis_soul_write when updates is not an object', async () => {
    const executor = createInProcessToolExecutor();
    await expect(
      executor.execute({
        id: 'call-soul-write-not-object',
        name: 'memphis_soul_write',
        arguments: { updates: 'just a string' },
      }),
    ).rejects.toThrow(/updates must be an object/);
  });

  it('normalizes model-string case query limit before adapter execution', async () => {
    const normalized = normalizeCaseQueryForToolCall({
      type: 'audit',
      limit: '30',
    });

    expect(normalized).toEqual({
      type: 'audit',
      limit: 30,
    });
  });

  it('passes normalized case query limit to the in-process adapter', async () => {
    const adapter = {
      appendCaseEntry: vi.fn(),
      queryCases: vi.fn(async () => ({ count: 0, cases: [] })),
    };
    const executor = createInProcessToolExecutor({ caseAdapter: adapter as never });

    await executor.execute({
      id: 'call-case-query-string-limit',
      name: 'memphis_case_query',
      arguments: {
        query: {
          type: 'audit',
          limit: '30',
        },
      },
    });

    expect(adapter.queryCases).toHaveBeenCalledWith({
      type: 'audit',
      limit: 30,
    });
  });

  it('accepts top-level case_append payloads from model tool calls', async () => {
    const adapter = {
      appendCaseEntry: vi.fn(async () => ({ success: true, index: 3, hash: 'h', chain: 'cases' })),
      queryCases: vi.fn(),
    };
    const executor = createInProcessToolExecutor({ caseAdapter: adapter as never });

    await executor.execute({
      id: 'call-case-append-top-level',
      name: 'memphis_case_append',
      arguments: {
        case_type: 'nominative',
        entity: 'profile',
        action: 'synced',
        timestamp: '2026-06-19T00:00:00.000Z',
      },
    });

    expect(adapter.appendCaseEntry).toHaveBeenCalledWith({
      case_type: 'nominative',
      entity: 'profile',
      action: 'synced',
      timestamp: '2026-06-19T00:00:00.000Z',
    });
  });

  it('rejects out-of-range case query limits before Rust parsing', async () => {
    const executor = createInProcessToolExecutor();
    await expect(
      executor.execute({
        id: 'call-case-query-limit-too-large',
        name: 'memphis_case_query',
        arguments: {
          query: {
            limit: '1000',
          },
        },
      }),
    ).rejects.toThrow(/limit must be an integer between 1 and 100/);
  });

  it('schema error includes Correct shape sample (2026-05-12 P1)', async () => {
    // After the 2026-05-11 23:27 episode where Memphis flipped array
    // <-> string on consecutive retries, the error message must include
    // a concrete sample of the correct shape so the model can self-
    // correct in one retry instead of round-tripping schema guesses.
    const executor = createInProcessToolExecutor();
    await expect(
      executor.execute({
        id: 'call-soul-write-with-sample',
        name: 'memphis_soul_write',
        arguments: {
          updates: { context: { activeWork: ['a', 'b'] } }, // array instead of string
        },
      }),
    ).rejects.toThrow(/Correct shape[\s\S]*activeWork[\s\S]*String-shape fields/);
  });
});
