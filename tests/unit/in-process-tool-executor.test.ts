import { describe, expect, it } from 'vitest';

import { createInProcessToolExecutor } from '../../src/gateway/tool-executor.js';

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
});
